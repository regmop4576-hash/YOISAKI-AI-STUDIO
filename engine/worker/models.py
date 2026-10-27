"""Read-only catalog. Stable v1.3.3 IDs, no paths accepted from HTTP clients."""
from pathlib import Path
from hashlib import sha256
import json, struct
KINDS={'checkpoints':'checkpoint','loras':'lora','vae':'vae','controlnet':'controlnet'}
def model_id(relative):return sha256(relative.encode()).hexdigest()[:32]
def contained(path,base):
    return path.resolve().is_relative_to(base.resolve())
def header(path):
    with path.open('rb') as f:
        raw=f.read(8)
        if len(raw)!=8:raise ValueError('Повреждён safetensors')
        n=struct.unpack('<Q',raw)[0]
        if n>32*1024*1024 or n>path.stat().st_size-8:raise ValueError('Повреждён заголовок')
        value=json.loads(f.read(n))
        if not isinstance(value,dict) or not isinstance(value.get('__metadata__',{}),dict):raise ValueError('Неверный заголовок safetensors')
        return value
def inspect(path,kind):
    if path.is_dir():
        conf=json.loads((path/'model_index.json').read_text())
        if not isinstance(conf,dict):raise ValueError('Неверный model_index.json')
        ok=conf.get('_class_name')=='StableDiffusionXLPipeline'
        return ('SDXL' if ok else 'unsupported',ok,{})
    h=header(path);meta=h.get('__metadata__',{});keys=list(h)
    if kind=='checkpoint':
        ok=any('conditioner.embedders.1.' in k for k in keys) and any('model.diffusion_model.' in k for k in keys)
        return ('SDXL' if ok else 'unsupported',ok,meta)
    if kind=='lora':
        hint=str(meta.get('ss_base_model_version',''))+' '+str(meta.get('modelspec.architecture',''))
        if any(x in hint.lower() for x in ('sd_v1','sd_v2','flux','sd3')):return ('unsupported',False,meta)
        ok='xl' in hint.lower() or any('lora_te2_' in k or 'text_encoder_2' in k for k in keys)
        return ('SDXL' if ok else 'unknown',True if ok else None,meta)
    if kind=='vae':
        # SD1/SDXL share VAE topology: header alone cannot prove latent scaling compatibility.
        ok=any(k.endswith('decoder.conv_in.weight') for k in keys) and any(k.endswith('encoder.conv_out.weight') for k in keys)
        return ('SDXL VAE candidate' if ok else 'unsupported',None if ok else False,meta)
    return ('unknown',None,meta)
def entries(root):
    base=Path(root).expanduser().resolve()
    for folder,kind in KINDS.items():
        directory=base/folder
        if not directory.is_dir() or not contained(directory,base):continue
        for p in directory.rglob('*'):
            if not contained(p,base) or not p.is_file():continue
            if p.suffix.lower()=='.safetensors':yield p,kind
            elif kind=='checkpoint' and p.name=='model_index.json':yield p.parent,kind

def scan(root):
    base=Path(root).expanduser().resolve();result=[]
    for p,kind in entries(base):
        try:
            arch,ok,meta=inspect(p,kind)
            # Sidecar is optional, never written; preserve trigger words and existing metadata.
            side=p.with_suffix('.json') if p.is_file() else p/'metadata.json'
            extra={}
            if side.is_file() and contained(side,base) and side.stat().st_size<1024*1024:
                try:extra=json.loads(side.read_text())
                except (ValueError,OSError):pass
            result.append(dict(id=model_id(p.relative_to(base).as_posix()),name=p.name,kind=kind,
                architecture=arch,compatible=ok,size_bytes=p.stat().st_size if p.is_file() else None,
                metadata=meta,sidecar=extra,trigger_words=extra.get('trigger_words',extra.get('trainedWords',meta.get('ss_tag_frequency',''))) if isinstance(extra,dict) else ''))
        except (ValueError,OSError,TypeError):
            result.append(dict(id=model_id(p.relative_to(base).as_posix()),name=p.name,kind=kind,architecture='invalid',compatible=False,size_bytes=None))
    return sorted(result,key=lambda x:(x['kind'],x['name']))
def resolve(root,identifier,kind):
    base=Path(root).expanduser().resolve()
    for path,k in entries(base):
        if k==kind and model_id(path.relative_to(base).as_posix())==identifier:
            _,ok,_=inspect(path,kind)
            if ok is False:raise ValueError('Модель несовместима. Выберите SDXL / Illustrious XL в формате safetensors.')
            return path.resolve()
    raise ValueError('Модель не найдена. Нажмите «Обновить модели».')
