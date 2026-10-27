import sys,io,json,uuid,time,gc,weakref
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
import pytest
from PIL import Image
from worker.results import ResultStore
from worker.memory import MemoryLog
from inference.text2img import InferenceAdapter

def test_disk_retention_ack_restart_and_quota(tmp_path):
    s=ResultStore(tmp_path/'results',limit=26*1024**2,ttl=1);ident=str(uuid.uuid4());s.reserve(ident,1)
    with Image.new('RGB',(256,256)) as im:s.save(ident,[im],123)
    assert not any(isinstance(v,bytes) for e in s.entries.values() for v in e.values())
    with patch('worker.results.time.time',return_value=time.time()+100000):s.cleanup()
    with s.open(ident,0) as f:assert f.read(8)==b'\x89PNG\r\n\x1a\n'
    r=ResultStore(s.root,ttl=1);assert r.restored_jobs()[ident]['result']['seed']==123
    r.ack(ident);handle=r.open(ident,0)
    with patch('worker.results.time.time',return_value=time.time()+10):r.cleanup()
    assert handle.read(8)==b'\x89PNG\r\n\x1a\n';handle.close()
    assert not r.entries
    s=ResultStore(tmp_path/'quota',limit=24*1024**2)
    with pytest.raises(ValueError):s.reserve(str(uuid.uuid4()),1)

def test_log_fields_and_no_private_request_data(tmp_path):
    log=MemoryLog(tmp_path/'models');row=log.sample('after_cleanup')
    parsed=json.loads(log.path.read_text());assert parsed==row
    assert row['process_rss_bytes']>0;assert row['system_ram_used_bytes']>0
    assert row['cuda_allocated_bytes'] is None
    assert not set(row)&{'prompt','token','checkpoint_id','mask','path'}

def test_adapter_cache_changes_weights_without_loading(tmp_path):
    class Pipe:
        def __init__(self):self.loads=[];self.unloads=0;self.weights=[];self._all_hooks=[]
        def load_lora_weights(self,*a,**kw):self.loads.append(kw['adapter_name'])
        def unload_lora_weights(self):self.unloads+=1
        def enable_lora(self):pass
        def disable_lora(self):pass
        def set_adapters(self,names,adapter_weights):self.weights=adapter_weights
    p=tmp_path/'model.safetensors';p.write_bytes(b'valid test stub')
    a=InferenceAdapter(tmp_path);a.pipe=Pipe()
    with patch('inference.text2img.resolve',return_value=p):
        a.prepare_adapters({});assert a.pipe.unloads==0
        req={'lora_adapters':[{'id':'a','weight':.5}]};a.prepare_adapters(req)
        req['lora_adapters'][0]['weight']=.8;a.prepare_adapters(req)
        assert a.pipe.loads==['adapter_0'];assert a.pipe.weights==[.8];assert a.pipe.unloads==0
        a.prepare_adapters({});assert a.pipe.unloads==1
        a.prepare_adapters({});assert a.pipe.unloads==1

def test_ten_disk_saves_storage_only(tmp_path):
    # This is a PNG storage test, NOT the requested ten GPU generations.
    s=ResultStore(tmp_path/'results');log=MemoryLog(tmp_path/'models')
    for i in range(10):
        ident=str(uuid.uuid4());s.reserve(ident,1)
        with Image.new('RGB',(1024,1024),(i*20,20,30)) as im:s.save(ident,[im],i)
        del im;gc.collect();row=log.sample('storage_only_'+str(i),results=s)
        assert row['result_ram_bytes']==0
    assert len(s.entries)==10;assert s.bytes_used()>0
    for e in s.entries.values():assert all(isinstance(p,Path) for p in e['paths'])

def test_atomic_failed_save_releases_reservation(tmp_path):
    s=ResultStore(tmp_path/'results');ident=str(uuid.uuid4());s.reserve(ident,1)
    class BadImage:
        def save(self,f,**kw):f.write(b'partial');raise OSError('test disk write')
    with pytest.raises(OSError):s.save(ident,[BadImage()])
    assert not s.reservations;assert not list(s.root.glob('*.tmp'));assert not list(s.root.glob('*.png'))

def test_cleanup_drops_callback_and_offloads_without_reinstall(tmp_path):
    class Hook:
        def __init__(self):self.calls=0
        def offload(self):self.calls+=1
    class Pipe:
        def __init__(self):self._all_hooks=[Hook()]
    a=InferenceAdapter(tmp_path);a.pipe=Pipe();a.measure=lambda phase:None
    hook=a.pipe._all_hooks[0];a.finish_job();assert hook.calls==1;assert a.pipe._all_hooks==[hook]

def test_cache_regional_to_style_to_off(tmp_path):
    class Pipe:
        def __init__(self):self.loads=[];self.unloads=0
        def load_lora_weights(self,*args,**kw):self.loads.append(kw['adapter_name'])
        def unload_lora_weights(self):self.unloads+=1
        def enable_lora(self):pass
        def disable_lora(self):pass
        def set_adapters(self,*args,**kw):pass
    path=tmp_path/'lora.safetensors';path.write_bytes(b'test stub');a=InferenceAdapter(tmp_path);a.pipe=Pipe()
    with patch('inference.text2img.resolve',return_value=path),patch('inference.regional.validate_regional_adapter'):
        req={'regions':[{'enabled':True,'lora_id':'a','weight':.6},{'enabled':True,'lora_id':'b','weight':.8}]}
        for _ in range(10):a.prepare_adapters(req)
        assert a.pipe.loads==['region_0','region_1'];assert a.pipe.unloads==0
        a.prepare_adapters({'lora_adapters':[{'id':'style','weight':.5}]});assert a.pipe.unloads==1
        a.prepare_adapters({});assert a.pipe.unloads==2
