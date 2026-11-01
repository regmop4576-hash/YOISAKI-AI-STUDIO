"""Bounded, whitelist-only measurements. Never serialize requests, paths or secrets."""
import json,os,time,threading
from pathlib import Path

class MemoryLog:
    def __init__(self,model_root):
        self.path=Path(model_root).parent/'diagnostics'/'memory.jsonl'
        self.lock=threading.Lock();self.last=None;self.write_ok=True;self.last_job=None
    def sample(self,phase,adapter=None,results=None,job_id=None):
        row={'time_unix':time.time(),'pid':os.getpid(),'phase':phase,'job_id':job_id,
             'system_ram_used_bytes':None,'system_ram_total_bytes':None,'process_rss_bytes':None,
             'cuda_allocated_bytes':None,'cuda_reserved_bytes':None,'cuda_peak_allocated_bytes':None,'cuda_peak_reserved_bytes':None,
             'pipeline_loaded':False,'adapter_count':0,'components':{},'offload_hook_count':0,
             'result_ram_bytes':0,'result_disk_bytes':results.bytes_used() if results else 0}
        try:
            mem={k:int(v.split()[0])*1024 for k,v in (line.split(':',1) for line in Path('/proc/meminfo').read_text().splitlines())}
            row.update(system_ram_total_bytes=mem['MemTotal'],system_ram_used_bytes=mem['MemTotal']-mem['MemAvailable'])
            row['process_rss_bytes']=int(Path('/proc/self/statm').read_text().split()[1])*os.sysconf('SC_PAGE_SIZE')
        except (OSError,ValueError,KeyError):pass
        try:
            import torch
            if torch.cuda.is_available():
                row.update(cuda_allocated_bytes=torch.cuda.memory_allocated(),cuda_reserved_bytes=torch.cuda.memory_reserved(),cuda_peak_allocated_bytes=torch.cuda.max_memory_allocated(),cuda_peak_reserved_bytes=torch.cuda.max_memory_reserved())
        except Exception:pass
        pipe=getattr(adapter,'pipe',None)
        if pipe is not None:
            row['pipeline_loaded']=True
            try:row['adapter_count']=len({n for names in pipe.get_list_adapters().values() for n in names})
            except (AttributeError,ValueError):pass
            for name in ('unet','vae','text_encoder','text_encoder_2','controlnet'):
                component=getattr(pipe,name,None)
                if component is None:continue
                try:
                    p=next(component.parameters());row['components'][name]={'device':str(p.device),'dtype':str(p.dtype)}
                    row['offload_hook_count']+=sum(hasattr(m,'_hf_hook') for m in component.modules())
                except (AttributeError,StopIteration):pass
        with self.lock:
            self.last=row
            try:
                self.path.parent.mkdir(parents=True,exist_ok=True)
                if self.path.exists() and self.path.stat().st_size>8*1024*1024:
                    backup=self.path.with_suffix('.previous.jsonl');os.replace(self.path,backup)
                with self.path.open('a',encoding='utf-8') as f:f.write(json.dumps(row,separators=(',',':'))+'\n')
                self.write_ok=True
            except OSError:self.write_ok=False
        return row

    def job_summary(self, summary):
        self.last_job=summary
        # Separate bounded JSONL uses the same rotation policy as phase measurements.
        with self.lock:
            try:
                path=self.path.with_name('resources.jsonl')
                path.parent.mkdir(parents=True,exist_ok=True)
                if path.exists() and path.stat().st_size>8*1024*1024:
                    os.replace(path,path.with_suffix('.previous.jsonl'))
                with path.open('a',encoding='utf-8') as f:
                    f.write(json.dumps(summary,separators=(',',':'))+'\n')
            except OSError:self.write_ok=False
