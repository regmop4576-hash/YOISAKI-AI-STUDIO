"""Sequential spatial noise composition, one shared SDXL pipeline.
Masks gate entire regional predictions (including adapter contributions), not attention
weights. Common latents/self-attention/VAE can still transmit identity across boundaries.
"""
import base64
import io
from contextlib import contextmanager
from PIL import Image


def decode_mask(value, width, height):
    if not isinstance(value, str) or not value.startswith('data:image/png;base64,') or len(value)>400000:
        raise ValueError('Regional mask must be a bounded PNG data URL')
    try:
        raw=base64.b64decode(value.split(',',1)[1],validate=True)
        with Image.open(io.BytesIO(raw)) as image:
            if image.format!='PNG' or image.size!=(width,height):
                raise ValueError('Mask dimensions must match generation resolution')
            result=image.convert('L');result.load()
    except Exception as exc:
        raise ValueError('Invalid regional PNG mask') from exc
    if result.getextrema()[1]==0:raise ValueError('Regional mask is empty')
    return result


def validate_regional_adapter(path):
    from worker.models import header
    if path.suffix.lower()!='.safetensors':raise ValueError('Regional LoRA must be safetensors')
    keys=list(header(path))
    if any(any(marker in k.lower() for marker in ('hada_','lokr_','oft_blocks')) for k in keys):
        raise ValueError('Regional mode supports standard LoRA, not LoHa/LoKr/OFT')
    if not any('lora_down' in k or 'lora_A' in k for k in keys):
        raise ValueError('No supported LoRA matrices in regional adapter')


def select_adapters(pipe, adapters, loaded):
    if not loaded:return
    if adapters:
        pipe.enable_lora()
        pipe.set_adapters([a[0] for a in adapters],adapter_weights=[a[1] for a in adapters])
    else:pipe.disable_lora()


@contextmanager
def regional_routing(pipe, req, global_adapters, regional_adapters, progress):
    import torch
    import numpy as np
    regions=[r for r in req.get('regions',[]) if r['enabled']]
    if not regions:
        yield
        return
    loaded=bool(global_adapters or any(regional_adapters))
    cfg=req['cfg_scale']>1
    device=pipe._execution_device
    contexts=[]
    # Encode each prompt with its own text-encoder adapters too. No other character
    # adapter is active during this pass. All inference below is under no_grad.
    with torch.no_grad():
        for region, adapters in zip(regions,regional_adapters):
            progress(0,'PREPARING')
            select_adapters(pipe,global_adapters+adapters,loaded)
            from inference.prompt_encoding import encode_long_prompt
            pos,neg,pooled,neg_pooled=encode_long_prompt(pipe,
                prompt=', '.join(filter(None,[req['prompt'],region['trigger'],region['prompt']])),
                negative_prompt=', '.join(filter(None,[req.get('negative_prompt',''),region['negative_prompt']])),
                device=device,num_images_per_prompt=1,do_classifier_free_guidance=cfg)
            mask=decode_mask(region['mask'],req['width'],req['height'])
            mask=mask.resize((req['width']//8,req['height']//8),Image.Resampling.BOX)
            mask=torch.from_numpy(np.array(mask,dtype=np.float32)/255).to(device=device,dtype=pos.dtype)[None,None]
            contexts.append((adapters,torch.cat([neg,pos]) if cfg else pos,
                             torch.cat([neg_pooled,pooled]) if cfg else pooled,mask))
    # First region wins overlaps, including partial coverage. Remaining area uses
    # the shared scene. Weights sum to 1 everywhere, without amplitude inflation.
    remaining=torch.ones_like(contexts[0][3]);weighted=[]
    for adapters,pos,pooled,mask in contexts:
        weight=remaining*mask;remaining=remaining*(1-mask)
        weighted.append((adapters,pos,pooled,weight))
    select_adapters(pipe,global_adapters,loaded)
    # A removable module hook survives Accelerate's rebuilding of offload wrappers
    # at pipeline completion. Never replace its forward/_old_forward methods.
    nested=False
    def routed(module,args,kwargs,base):
        nonlocal nested
        if nested:return base
        noise=base[0]*remaining
        nested=True
        try:
            for adapters,pos,pooled,weight in weighted:
                progress(-1,'GENERATING')
                select_adapters(pipe,global_adapters+adapters,loaded)
                options={**kwargs,'encoder_hidden_states':pos,
                         'added_cond_kwargs':{**kwargs['added_cond_kwargs'],'text_embeds':pooled}}
                part=module(*args,**options)[0]
                noise.add_(part*weight)
            return (noise,)
        finally:
            nested=False
            select_adapters(pipe,global_adapters,loaded)
    handle=pipe.unet.register_forward_hook(routed,with_kwargs=True)
    try:yield
    finally:
        handle.remove()
        select_adapters(pipe,global_adapters,loaded)
