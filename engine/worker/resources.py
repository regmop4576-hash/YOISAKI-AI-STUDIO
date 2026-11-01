"""Measured admission lower bounds and per-job resource summaries; no prompt data.

Admission only rules out demonstrably insufficient resources. It is not a claim
that transient model activations fit. The existing CPU-offload/allocator policy
owns model lifetime and RAM trimming.
"""
import os
import threading
import time
from pathlib import Path

class ResourceError(ValueError):
    pass

def snapshot():
    row = dict(ram_available_bytes=None, ram_used_bytes=None, process_rss_bytes=None,
               cuda_free_bytes=None, cuda_allocated_bytes=None, cuda_reserved_bytes=None,
               cuda_peak_allocated_bytes=None, cuda_peak_reserved_bytes=None)
    try:
        mem = {k:int(v.split()[0])*1024 for k,v in (x.split(':',1) for x in Path('/proc/meminfo').read_text().splitlines())}
        available = mem['MemAvailable']
        # Containers can have less RAM than the host reports.
        for parent in (Path('/sys/fs/cgroup'),):
            maximum, current = parent/'memory.max', parent/'memory.current'
            if maximum.exists() and maximum.read_text().strip().isdigit():
                available = min(available, max(0,int(maximum.read_text())-int(current.read_text())))
        row.update(ram_available_bytes=available,ram_used_bytes=mem['MemTotal']-mem['MemAvailable'],
                   process_rss_bytes=int(Path('/proc/self/statm').read_text().split()[1])*os.sysconf('SC_PAGE_SIZE'))
    except (OSError,ValueError,KeyError):
        pass
    try:
        import torch
        if torch.cuda.is_available():
            row.update(cuda_free_bytes=torch.cuda.mem_get_info()[0],cuda_allocated_bytes=torch.cuda.memory_allocated(),
                       cuda_reserved_bytes=torch.cuda.memory_reserved(),cuda_peak_allocated_bytes=torch.cuda.max_memory_allocated(),
                       cuda_peak_reserved_bytes=torch.cuda.max_memory_reserved())
    except (ImportError,RuntimeError,AttributeError):
        pass
    return row

def check_budget(req):
    row = snapshot()
    # Exact lower bound: one fp16 latent and its CFG duplicate. Does not estimate UNet activations.
    latent_bytes = (req['width']//8)*(req['height']//8)*4*2*req['batch_size']*(2 if req['cfg_scale']>1 else 1)
    if row['cuda_free_bytes'] is not None:
        reclaimable = max(0,(row['cuda_reserved_bytes'] or 0)-(row['cuda_allocated_bytes'] or 0))
        if row['cuda_free_bytes']+reclaimable < latent_bytes:
            raise ResourceError('Недостаточно доступной VRAM даже для латентов. Освободите GPU или уменьшите рабочее разрешение/batch.')
    if req.get('mode') in ('inpaint','facefix'):
        from inference.editor import decode
        with decode(req['init_image']) as source:
            # Minimum concurrently resident original RGBA + RGBA output + L blend mask + RGB work image.
            known_buffers = source.width*source.height*9+req['width']*req['height']*3
        if row['ram_available_bytes'] is not None and row['ram_available_bytes'] < known_buffers:
            raise ResourceError('Недостаточно системной RAM для исходника и результата. Уменьшите исходный файл или освободите RAM.')
    return row

class JobResources:
    def __init__(self, mode):
        self.mode=mode
        self.started=time.monotonic()
        self.before={}
        self.stop=threading.Event()
        self.thread=None
        self.peak_ram=0
        self.peak_rss=0

    def start(self, adapter=None):
        self.started=time.monotonic()
        self.before=snapshot()
        pipe=getattr(adapter,'pipe',None)
        self.loaded_before=dict(pipeline_type=type(pipe).__name__ if pipe else None,adapter_count=len(getattr(adapter,'adapter_key',())),optional_components=[k for k in ('controlnet',) if getattr(pipe,k,None) is not None])
        self.observe(self.before)
        def sample():
            # No CUDA work in this thread; only OS RAM measurements.
            while not self.stop.wait(.25):
                try:
                    mem={k:int(v.split()[0])*1024 for k,v in (x.split(':',1) for x in Path('/proc/meminfo').read_text().splitlines())}
                    self.observe(dict(ram_used_bytes=mem['MemTotal']-mem['MemAvailable'],process_rss_bytes=int(Path('/proc/self/statm').read_text().split()[1])*os.sysconf('SC_PAGE_SIZE')))
                except (OSError,ValueError,KeyError):pass
        self.thread=threading.Thread(target=sample,daemon=True)
        self.thread.start()

    def observe(self, row):
        self.peak_ram=max(self.peak_ram,row.get('ram_used_bytes') or 0)
        self.peak_rss=max(self.peak_rss,row.get('process_rss_bytes') or 0)

    def finish(self, adapter, cleanup):
        self.stop.set()
        if self.thread:self.thread.join(timeout=1)
        after=snapshot()
        self.observe(after)
        pipe=getattr(adapter,'pipe',None)
        return dict(job_type=self.mode,duration_seconds=round(time.monotonic()-self.started,3),before=self.before,
                    after_cleanup=after,peak_system_ram_used_bytes=self.peak_ram,peak_process_rss_bytes=self.peak_rss,
                    ram_sampling_interval_seconds=.25,loaded_before=getattr(self,'loaded_before',{}),inference_pipeline=getattr(adapter,'last_pipeline_type',None),model_reused=getattr(adapter,'model_reused',False),
                    pipeline_type=type(pipe).__name__ if pipe else None,adapter_count=len(getattr(adapter,'adapter_key',())),
                    optional_components=[k for k in ('controlnet',) if getattr(pipe,k,None) is not None],cleanup=cleanup)
