"""Opt-in, process-local, diagnostic-only memory sampling for YOISAKI ENGINE.

NO tensor content, prompts, paths, tokens or user model names are persisted.
All measurements are indicative snapshots, not a complete accounting of memory.
"""
from __future__ import annotations
import csv
import ctypes
import gc
import json
import os
from pathlib import Path
import platform
import sys
import threading
import time
from datetime import datetime, timezone

MEMBER_NAMES = ('unet', 'vae', 'text_encoder', 'text_encoder_2')
CSV_FIELDS = ('timestamp_utc', 'time_unix', 'job_id', 'stage', 'system_total_bytes',
              'system_available_bytes', 'system_used_bytes', 'system_swap_total_bytes',
              'system_swap_used_bytes', 'process_rss_bytes', 'process_uss_bytes',
              'process_pss_bytes', 'process_peak_rss_bytes', 'child_rss_bytes',
              'cuda_allocated_bytes', 'cuda_reserved_bytes', 'cuda_peak_allocated_bytes',
              'cuda_peak_reserved_bytes')

def _utc():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')

def _kv_file(path):
    try:
        d = {}
        for line in Path(path).read_text().splitlines():
            if ':' in line:
                k,v = line.split(':',1)
                fields = v.strip().split()
                if len(fields) == 2 and fields[1] == 'kB':
                    try:d[k] = int(fields[0])*1024
                    except ValueError:continue
        return d
    except (OSError, ValueError, IndexError):
        return {}

def snapshot(stage, job_id=None, include_full_info=True):
    """Linux /proc + CUDA allocator counters, without synchronizing CUDA."""
    row = {k: None for k in CSV_FIELDS}
    row.update(timestamp_utc=_utc(), time_unix=time.time(), job_id=job_id, stage=stage)
    m = _kv_file('/proc/meminfo')
    total, available = m.get('MemTotal'), m.get('MemAvailable')
    row.update(system_total_bytes=total, system_available_bytes=available,
               system_used_bytes=total-available if total is not None and available is not None else None,
               system_swap_total_bytes=m.get('SwapTotal'),
               system_swap_used_bytes=max(0,m['SwapTotal']-m['SwapFree']) if 'SwapTotal' in m and 'SwapFree' in m else None)
    st = _kv_file('/proc/self/status')
    row['process_rss_bytes'] = st.get('VmRSS')
    row['process_peak_rss_bytes'] = st.get('VmHWM')
    if include_full_info:
        roll = _kv_file('/proc/self/smaps_rollup')
        row['process_pss_bytes'] = roll.get('Pss')
        if 'Private_Clean' in roll and 'Private_Dirty' in roll:
            row['process_uss_bytes'] = roll['Private_Clean']+roll['Private_Dirty']
    try:
        # Children are usually absent in the worker; explicitly mark unavailable on failure.
        children = []
        for name in os.listdir('/proc'):
            if not name.isdigit():continue
            stat = Path('/proc',name,'stat').read_text()
            rest = stat.rsplit(')',1)[1].split()
            if int(rest[1]) == os.getpid():
                status = _kv_file(Path('/proc',name,'status'))
                if status.get('VmRSS') is not None: children.append(status['VmRSS'])
        row['child_rss_bytes'] = sum(children)
    except (OSError, ValueError, IndexError):pass
    try:
        import torch
        if torch.cuda.is_available():
            row.update(cuda_allocated_bytes=int(torch.cuda.memory_allocated()),
                       cuda_reserved_bytes=int(torch.cuda.memory_reserved()),
                       cuda_peak_allocated_bytes=int(torch.cuda.max_memory_allocated()),
                       cuda_peak_reserved_bytes=int(torch.cuda.max_memory_reserved()))
    except (ImportError, RuntimeError):pass
    return row

def _storage_key(t):
    """Deduplicate tensor views sharing a storage. Offset isn't a distinct allocation."""
    try:
        store = t.untyped_storage()
        pointer=int(store.data_ptr())
        if t.device.type=='meta' or pointer==0:return None,0
        return (t.device.type, t.device.index, pointer, int(store.nbytes())), int(store.nbytes())
    except (AttributeError, RuntimeError, TypeError):
        return None, int(t.numel()*t.element_size())

def inspect_components(pipe):
    res = {'timestamp_utc':_utc(),'components':{},'pipeline_attached':pipe is not None,
           'total_pipeline_objects':'unavailable: no safe complete registry',
           'estimation_note':'Unique parameter and buffer storage sizes, NOT full physical RSS/VRAM; shared storages are deduplicated across components.'}
    if pipe is None:return res
    shared=set(); total_est=0
    for name in MEMBER_NAMES:
        module=getattr(pipe,name,None)
        if module is None:
            res['components'][name]={'available':False};continue
        entry={'available':True,'parameters':0,'buffers':0,'unique_storage_estimate_bytes':0,
               'devices':{},'dtypes':{},'offload_hook_count':0,'offload_hook_types':{},
               'hf_hook_present':False,'cpu_offload_hook_count':0,'offload_hook_config':{}}
        try:
            for child in module.modules():
                hook=getattr(child,'_hf_hook',None)
                if hook is not None:
                    entry['offload_hook_count']+=1
                    typ=type(hook).__name__
                    entry['offload_hook_types'][typ]=entry['offload_hook_types'].get(typ,0)+1
                    if 'CpuOffload' in typ:entry['cpu_offload_hook_count']+=1
                    # Hook settings only: never walk offload weight maps or force CPU/GPU transfers.
                    for flag in ('offload','offload_buffers','io_same_device','place_submodules'):
                        val=getattr(hook,flag,None)
                        if isinstance(val,bool):entry['offload_hook_config'][flag]=val
            entry['hf_hook_present']=entry['offload_hook_count']>0
            for kind, seq in (('parameters',module.parameters()),('buffers',module.buffers())):
                for t in seq:
                    entry[kind]+=1
                    dev, dt=str(t.device),str(t.dtype)
                    entry['devices'][dev]=entry['devices'].get(dev,0)+1
                    entry['dtypes'][dt]=entry['dtypes'].get(dt,0)+1
                    key,size=_storage_key(t)
                    if key is None:
                        # Never call an estimated fallback a unique storage allocation.
                        continue
                    if key not in shared:
                        shared.add(key);entry['unique_storage_estimate_bytes']+=size;total_est+=size
        except Exception as exc:
            entry['partial_error']=type(exc).__name__
        res['components'][name]=entry
    res['all_components_unique_storage_estimate_bytes']=total_est
    res['pipeline_offload_hook_count']=len(getattr(pipe,'_all_hooks',[]) or [])
    return res

def inspect_cpu_tensors(max_objects=160000, max_seconds=3.0, min_available_bytes=2*1024**3, max_scan_rss_growth=128*1024**2):
    """Bounded GC-visible subset only; cannot enumerate PyTorch/C++ allocator objects."""
    base=snapshot('tensor_scan_start',include_full_info=False)
    av=base['system_available_bytes']
    result={'timestamp_utc':_utc(),'coverage':'GC-tracked Python torch.Tensor subset only; C++ and untracked tensors excluded',
            'tensor_contents_exported':False,'complete_enumeration':False,'status':'unavailable',
            'object_limit':max_objects,'duration_limit_seconds':max_seconds}
    if av is None or av<min_available_bytes:
        result['reason']='insufficient_or_unknown_available_RAM';return result
    start=time.monotonic()
    objects=None
    try:
        import torch
        objects=gc.get_objects()
        result['gc_objects_seen']=len(objects)
        if len(objects)>max_objects:
            result['reason']='gc_object_limit_exceeded';return result
        storages=set();counts={};shapes={};total=0;nt=0
        for o in objects:
            if time.monotonic()-start>max_seconds:
                result['reason']='time_budget_exceeded';return result
            if not isinstance(o,torch.Tensor) or o.device.type!='cpu':continue
            nt+=1
            if nt>25000:
                result['reason']='tensor_limit_exceeded';return result
            dtype=str(o.dtype);counts[dtype]=counts.get(dtype,0)+1
            shape=tuple(int(dim) for dim in o.shape)
            # Only bounded metadata summaries. Report a few examples, no per-tensor full dump.
            if len(shapes)<25 or str(shape) in shapes:shapes[str(shape)]=shapes.get(str(shape),0)+1
            key,size=_storage_key(o)
            if key is not None and key not in storages:
                storages.add(key);total+=size
        result.update(status='ok',tensor_count=nt,unique_storage_count=len(storages),
                      unique_storage_estimate_bytes=total,by_dtype=counts,shape_examples=shapes)
    except (MemoryError, RuntimeError) as exc:
        result['reason']=type(exc).__name__
    except Exception as exc:
        result['reason']='scan_error_'+type(exc).__name__
    finally:
        del objects
        # Object list itself can transiently expand process RSS; do not call gc.collect here.
        end=snapshot('tensor_scan_end',include_full_info=False)
        b,e=base['process_rss_bytes'],end['process_rss_bytes']
        result['scan_rss_delta_bytes']=e-b if b is not None and e is not None else None
        result['duration_seconds']=round(time.monotonic()-start,3)
        if result['scan_rss_delta_bytes'] is not None and result['scan_rss_delta_bytes']>max_scan_rss_growth:
            result['status']='disabled';result['reason']='scan_increased_RSS_beyond_budget'
            for k in ('tensor_count','by_dtype','shape_examples','unique_storage_estimate_bytes','unique_storage_count'):
                result.pop(k,None)
    return result

def allocator_experiment():
    """Opt-in glibc experiment, ONLY caller after completed job cleanup."""
    result={'timestamp_utc':_utc(),'method':'glibc malloc_trim(0) optional experiment',
            'performed':False,'before':snapshot('before_malloc_trim'), 'after':None,
            'rss_difference_bytes':None,'interpretation':'Change in RSS alone cannot prove leak or its absence.'}
    if platform.system()!='Linux' or platform.libc_ver()[0]!='glibc':
        result['reason']='glibc_not_detected';return result
    try:
        libc=ctypes.CDLL('libc.so.6')
        fn=libc.malloc_trim;fn.argtypes=[ctypes.c_size_t];fn.restype=ctypes.c_int
    except (OSError, AttributeError):
        result['reason']='malloc_trim_unavailable';return result
    try:
        result['malloc_trim_result']=int(fn(0));result['performed']=True
        result['after']=snapshot('after_malloc_trim')
        b,a=result['before']['process_rss_bytes'],result['after']['process_rss_bytes']
        if b is not None and a is not None:result['rss_difference_bytes']=a-b
    except Exception as exc:
        result['reason']=type(exc).__name__
    return result

def minimal_environment():
    info={'timestamp_utc':_utc(),'platform':platform.system(), 'platform_release':platform.release(),
          'python_version':sys.version.split()[0],'pid':os.getpid(),
          'system_ram_total_bytes':snapshot('environment',include_full_info=False)['system_total_bytes'],
          'cuda_available':None,'cuda_device_name':None,'cuda_total_memory_bytes':None,
          'torch_version':None,'diffusers_version':None,'accelerate_version':None,
          'libc':platform.libc_ver(),
          'malloc_mmap_threshold_requested':os.environ.get('MALLOC_MMAP_THRESHOLD_'),
          'custom_allocator_preload_present':bool(os.environ.get('LD_PRELOAD')),
          'glibc_malloc_tunables_present':'glibc.malloc.' in os.environ.get('GLIBC_TUNABLES','')}
    try:
        import torch
        info['torch_version']=torch.__version__
        info['cuda_available']=torch.cuda.is_available()
        if info['cuda_available']:
            info['cuda_device_name']=torch.cuda.get_device_name()
            info['cuda_total_memory_bytes']=int(torch.cuda.get_device_properties(0).total_memory)
    except Exception:pass
    try:
        from importlib.metadata import version
        for name in ('diffusers','accelerate'):
            try:info[name+'_version']=version(name)
            except Exception:pass
    except ImportError:pass
    return info

class JobProfiler:
    def __init__(self,model_root,job_id,config):
        self.job_id=job_id
        self.config=config
        self.interval=max(.25,min(10.,float(config.get('sampling_interval',1))))
        self.stage='before_model_load';self._stop=threading.Event();self._lock=threading.RLock()
        self._thread=None;self.errors=[];self.snapshots=0;self.scan_disabled=False
        root=Path(model_root).resolve().parent/'diagnostics'/'reports'
        self.folder=root/(config['run_id']+'.partial')
        # run_id is regex-validated by load_control().
        self.folder.mkdir(parents=True,exist_ok=True)
        self._write_json(self.folder/'environment.json',minimal_environment(),overwrite=False)
    def _write_json(self,path,data,overwrite=True):
        if not overwrite and path.exists():return
        tmp=path.with_name(path.name+'.tmp_'+str(os.getpid()))
        try:
            tmp.write_text(json.dumps(data,ensure_ascii=False,indent=2,default=str),encoding='utf-8')
            os.replace(tmp,path)
        finally:tmp.unlink(missing_ok=True)
    def _append(self,filename,data):
        path=self.folder/filename
        with self._lock, path.open('a',encoding='utf-8') as f:
            f.write(json.dumps(data,ensure_ascii=False,separators=(',',':'),default=str)+'\n')
            f.flush()
    def _row(self,stage):
        data=snapshot(stage,self.job_id)
        with self._lock:
            first=not (self.folder/'memory_timeline.csv').exists()
            with (self.folder/'memory_timeline.csv').open('a',newline='',encoding='utf-8') as f:
                writer=csv.DictWriter(f,fieldnames=CSV_FIELDS)
                if first:writer.writeheader()
                writer.writerow({k:data.get(k) for k in CSV_FIELDS});f.flush()
        return data
    def mark(self,stage,adapter=None):
        # Only original named execution boundaries are marked. No artificial sleep.
        self.stage=stage
        try:
            row=self._row(stage)
            self._append('generation_stages.jsonl',{'timestamp_utc':row['timestamp_utc'],'time_unix':row['time_unix'],
                'job_id':self.job_id,'stage':stage,'memory':{k:v for k,v in row.items() if k not in ('job_id','stage')}})
            if stage in ('after_model_load','after_cleanup'):
                sample=inspect_components(getattr(adapter,'pipe',None))
                sample.update(job_id=self.job_id,stage=stage)
                self._append('component_samples.jsonl',sample)
                if self.config.get('detailed_tensors',False) and not self.scan_disabled:
                    tensor=inspect_cpu_tensors(min_available_bytes=int(self.config.get('min_scan_available_bytes',2*1024**3)))
                    if tensor.get('status')=='disabled':self.scan_disabled=True
                    tensor.update(job_id=self.job_id,stage=stage)
                    self._append('tensor_samples.jsonl',tensor)
        except Exception as exc:
            self.errors.append('mark '+stage+': '+type(exc).__name__)
    def start(self):
        self.mark('job_start')
        self._thread=threading.Thread(target=self._loop,name='yoisaki-memory-sampler',daemon=True)
        self._thread.start()
    def _loop(self):
        while not self._stop.wait(self.interval):
            try:self._row(self.stage)
            except Exception as exc:self.errors.append('sample: '+type(exc).__name__)
    def finish(self,adapter=None,allow_allocator=False):
        self._stop.set()
        if self._thread and threading.current_thread()!=self._thread:self._thread.join(timeout=3)
        if allow_allocator and self.config.get('allocator_test',False):
            # Invoked in worker finally AFTER images released, offload hooks finished & gc.collect.
            try:self._append('allocator_samples.jsonl',{'job_id':self.job_id,**allocator_experiment()})
            except Exception as exc:self.errors.append('allocator: '+type(exc).__name__)
        self._append('job_status.jsonl',{'job_id':self.job_id,'status':'profiling_stopped',
            'timestamp_utc':_utc(),'errors':self.errors})

def load_control(model_root,job_id):
    """Opt-in local file control, keyed by client_request_id; no new HTTP routes."""
    import re
    if not re.fullmatch('[a-f0-9-]{36}',job_id):return None
    folder=Path(__file__).resolve().parents[1]/'.profiler_control'
    path=folder/(job_id+'.json')
    try:
        if not path.is_file() or path.stat().st_size>2048:return None
        config=json.loads(path.read_text())
        path.unlink(missing_ok=True)  # One-shot: site traffic does not inherit profiling.
        if config.get('job_id')!=job_id:return None
        if not re.fullmatch('[0-9]{8}T[0-9]{6}Z_[a-f0-9]{10}',str(config.get('run_id',''))):return None
        if abs(time.time()-float(config.get('created_unix',0)))>600:return None
        # Guard against injecting data into an arbitrary folder.
        return {k:config[k] for k in ('run_id','job_id','sampling_interval','detailed_tensors',
            'allocator_test','min_scan_available_bytes') if k in config}
    except (OSError,ValueError,TypeError,KeyError):return None
