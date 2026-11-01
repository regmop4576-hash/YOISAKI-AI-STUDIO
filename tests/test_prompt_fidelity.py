"""Small randomly initialized SDXL components + real PEFT LoRAs, CPU only.
Checks framework execution, not pretrained SDXL quality or T4 memory consumption.
"""
import unittest,sys,tempfile,json,io,base64
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
import torch
from PIL import Image
from diffusers import StableDiffusionXLPipeline,UNet2DConditionModel,AutoencoderKL,EulerDiscreteScheduler,DPMSolverMultistepScheduler,EulerAncestralDiscreteScheduler
from transformers import CLIPTextConfig,CLIPTextModel,CLIPTextModelWithProjection,CLIPTokenizer
from peft import LoraConfig
from inference.regional import regional_routing,select_adapters

import pytest
from inference.prompt_encoding import encode_long_prompt, token_plan, MAX_CHUNKS

@pytest.fixture
def pipe(tmp_path):
    torch.set_num_threads(2);torch.manual_seed(7)
    folder=tmp_path
    root=Path(folder);vocab={'<|startoftext|>':0,'<|endoftext|>':1}
    for c in 'abcdefghijklmnopqrstuvwxyz':vocab[c]=len(vocab);vocab[c+'</w>']=len(vocab)
    (root/'vocab.json').write_text(json.dumps(vocab));(root/'merges.txt').write_text('#version: 0.2\n')
    tokenizer=CLIPTokenizer(vocab_file=str(root/'vocab.json'),merges_file=str(root/'merges.txt'),model_max_length=77)
    config=CLIPTextConfig(vocab_size=len(vocab),hidden_size=8,intermediate_size=16,num_hidden_layers=2,num_attention_heads=2,max_position_embeddings=77,projection_dim=8,bos_token_id=0,eos_token_id=1,pad_token_id=1)
    unet=UNet2DConditionModel(sample_size=4,in_channels=4,out_channels=4,down_block_types=('CrossAttnDownBlock2D','DownBlock2D'),up_block_types=('UpBlock2D','CrossAttnUpBlock2D'),block_out_channels=(16,32),layers_per_block=1,cross_attention_dim=16,attention_head_dim=4,norm_num_groups=4,addition_embed_type='text_time',addition_time_embed_dim=2,projection_class_embeddings_input_dim=20)
    vae=AutoencoderKL(block_out_channels=(8,8,8,8),down_block_types=('DownEncoderBlock2D',)*4,up_block_types=('UpDecoderBlock2D',)*4,norm_num_groups=4,latent_channels=4)
    pipe=StableDiffusionXLPipeline(vae=vae,text_encoder=CLIPTextModel(config),text_encoder_2=CLIPTextModelWithProjection(config),tokenizer=tokenizer,tokenizer_2=tokenizer,unet=unet,scheduler=EulerDiscreteScheduler(),add_watermarker=False)
    for name in ['a','b']:
        unet.add_adapter(LoraConfig(r=2,lora_alpha=2,target_modules=['to_q','to_k','to_v','to_out.0']),adapter_name=name)
        for param_name,p in unet.named_parameters():
            if 'lora_' in param_name and '.'+name+'.' in param_name:
                with torch.no_grad():p.normal_(std=.2)
    for encoder in [pipe.text_encoder,pipe.text_encoder_2]:
        for name in ['a','b']:
            encoder.add_adapter(LoraConfig(r=2,lora_alpha=2,target_modules=['q_proj','v_proj']),adapter_name=name)
            for param_name,p in encoder.named_parameters():
                if 'lora_' in param_name and '.'+name+'.' in param_name:
                    with torch.no_grad():p.normal_(std=.2)
    return pipe

def test_short_native_parity(pipe):
    for adapters in [[], [('a',1.15)], [('a',1.15),('b',.8)]]:
        select_adapters(pipe,adapters,True)
        with torch.no_grad():
            expected=pipe.encode_prompt('bat',negative_prompt='fox')
            actual=encode_long_prompt(pipe,'bat','fox')
        for x,y in zip(expected,actual):torch.testing.assert_close(x,y,rtol=0,atol=0)


def test_long_tail_both_encoders_and_negative(pipe):
    positive='bat, '*40+'white sweater, rooftop'
    negative='fox, '*55+'mask'
    plan=token_plan(pipe,positive,negative,include_text=True)
    assert all(r['positive']['native_discarded_tokens']>0 for r in plan['encoders'])
    assert all('rooftop' in r['positive']['native_discarded_text'].replace(' ','') for r in plan['encoders'])
    seen=[[],[]];hooks=[]
    for i,encoder in enumerate([pipe.text_encoder,pipe.text_encoder_2]):
        hooks.append(encoder.register_forward_pre_hook(lambda m,args,i=i:seen[i].append(args[0].clone())))
    values=encode_long_prompt(pipe,positive,negative,num_images_per_prompt=2)
    for h in hooks:h.remove()
    assert values[0].shape==(2,77*plan['chunks'],16)
    assert values[0].shape==values[1].shape and values[2].shape==(2,8)
    assert all(x.device.type=='cpu' and not x.requires_grad and torch.isfinite(x).all() for x in values)
    for tokenizer,windows in zip([pipe.tokenizer,pipe.tokenizer_2],seen):
        for branch,text in enumerate([positive,negative]):
            original=tokenizer(text,add_special_tokens=False).input_ids
            recovered=[]
            for w in windows[branch*plan['chunks']:(branch+1)*plan['chunks']]:
                n=min(75,len(original)-len(recovered));recovered+=w[0,1:1+n].tolist()
            assert original==recovered
    changed=encode_long_prompt(pipe,positive.replace('rooftop','street'),negative)
    torch.testing.assert_close(values[1][0],changed[1][0])
    assert not torch.equal(values[0][0],changed[0][0])
    first=pipe.tokenizer_2(positive,return_tensors='pt',padding='max_length',max_length=77,truncation=True).input_ids
    with torch.no_grad():pool=pipe.text_encoder_2(first).text_embeds
    torch.testing.assert_close(values[2][0],pool[0])


def test_A_B_C_D_E_real_cpu_inference(pipe):
    prompt='bat, '*40+'white sweater rooftop'
    baseline=None
    for adapters,text,cfg,batch in [([],prompt,5,1),([('a',1.15)],prompt,5,1),([('a',1.15),('b',.8)],prompt,5,1),([],prompt+' street',5,2),([],prompt,5,1),([],prompt,1,1)]:
        select_adapters(pipe,adapters,True)
        values=encode_long_prompt(pipe,text,'fox, '*30,do_classifier_free_guidance=cfg>1)
        keys=('prompt_embeds','negative_prompt_embeds','pooled_prompt_embeds','negative_pooled_prompt_embeds')
        with torch.no_grad():
            result=pipe(**dict(zip(keys,values)),num_images_per_prompt=batch,width=32,height=32,num_inference_steps=2,guidance_scale=cfg,output_type='latent',generator=torch.Generator().manual_seed(42)).images
        assert result.shape==(batch,4,4,4) and torch.isfinite(result).all()
        if baseline is None:baseline=result.clone()
        elif not adapters and text==prompt and cfg==5:torch.testing.assert_close(baseline,result,rtol=0,atol=0)
        elif adapters:assert not torch.equal(baseline,result)
        for encoder in [pipe.unet,pipe.text_encoder,pipe.text_encoder_2]:
            for module in encoder.modules():
                if hasattr(module,'scaling'):
                    for name,weight in adapters:assert module.scaling[name]==weight


def test_limit_rejects_without_truncating(pipe):
    with pytest.raises(ValueError,match='Nothing was truncated'):
        encode_long_prompt(pipe,'bat '*1000)


def test_different_tokenizer_lengths(pipe):
    # SDXL's tokenizers can yield different counts; align every branch to common windows.
    original=pipe.tokenizer_2
    class Different:
        def __getattr__(self,name):return getattr(original,name)
        def __call__(self,text,*a,**kw):return original(text+' extra '*20,*a,**kw)
    pipe.tokenizer_2=Different()
    p=token_plan(pipe,'bat '*25,'fox')
    assert p['encoders'][0]['positive']['content_tokens']!=p['encoders'][1]['positive']['content_tokens']
    a,b,c,d=encode_long_prompt(pipe,'bat '*25,'fox')
    assert a.shape==b.shape==(1,77*p['chunks'],16)


def test_manager_file_switch_weight_change_and_unload(tmp_path,monkeypatch):
    from inference.text2img import InferenceAdapter
    from unittest.mock import MagicMock
    for name in ['amber','diives']:(tmp_path/name).write_bytes(b'file')
    monkeypatch.setattr('inference.text2img.resolve',lambda root,ident,kind:tmp_path/ident)
    adapter=InferenceAdapter(tmp_path);adapter.pipe=MagicMock()
    for entries in [[],[('amber',1.15)],[('amber',1.15),('diives',.8)],[('amber',.5),('diives',.2)],[('diives',.8)],[]]:
        globals_,regions=adapter.prepare_adapters({'lora_adapters':[{'id':i,'weight':w} for i,w in entries],'regions':[]})
        assert not regions
        assert globals_==[('adapter_'+str(i),w) for i,(_,w) in enumerate(entries)]
        if entries:adapter.pipe.set_adapters.assert_called_with([a for a,w in globals_],adapter_weights=[w for a,w in globals_])
    assert adapter.pipe.load_lora_weights.call_count==4
    assert adapter.pipe.unload_lora_weights.call_count==3
    assert adapter.adapter_key==()


def test_request_schema_preserves_strings_and_weights():
    from worker.direct_server import AdapterRequest
    r=dict(prompt='  bat,\n'+('white sweater, '*80),negative_prompt='  mask,\n'+('blur, '*90),checkpoint_id='a'*32,width=512,height=512,steps=30,cfg_scale=7,sampler='Euler',scheduler='Normal',seed=42,batch_size=1,lora_adapters=[{'id':'b'*32,'weight':1.15},{'id':'c'*32,'weight':.8}])
    out=AdapterRequest(**r).model_dump()
    for key,value in r.items():assert out[key]==value


def test_generate_entrypoint_scheduler_reset_trace_and_profiler(pipe,monkeypatch):
    from inference.text2img import InferenceAdapter
    from unittest.mock import MagicMock
    adapter=InferenceAdapter('/unused');adapter.pipe=pipe
    adapter.scheduler_config=dict(pipe.scheduler.config)
    monkeypatch.setattr(adapter,'load',lambda *args:pipe)
    monkeypatch.setattr(adapter,'prepare_adapters',lambda req:(select_adapters(pipe,[],True) or ([],[])))
    adapter.profiler=MagicMock()
    request=dict(mode='text2img',checkpoint_id='a'*32,prompt='bat, '*40+'rooftop',negative_prompt='fox',width=32,height=32,steps=2,cfg_scale=5,batch_size=1,seed=42,sampler='DPM++ 2M',scheduler='Karras')
    for sampler,schedule in [('DPM++ 2M','Karras'),('Euler','Normal'),('DPM++ 2M','Normal')]:
        images,seed=adapter.generate(request|dict(sampler=sampler,scheduler=schedule),lambda *args:None)
        assert seed==42 and len(images)==1;images[0].close()
        assert pipe.scheduler.config.use_karras_sigmas==(schedule=='Karras')
        trace=adapter.last_trace
        assert trace['tokens']['chunks']>1
        assert trace['active_adapters']==[] and trace['regional_enabled'] is False
        assert 'prompt' not in trace['settings'] and 'rooftop' not in json.dumps(trace)
        assert trace['embedding_bytes']>0
        assert not pipe.unet._forward_pre_hooks and not pipe.unet._forward_hooks
        adapter.finish_job()
    marks=[call.args[0] for call in adapter.profiler.mark.call_args_list]
    assert 'before_text_encoding' in marks and 'after_text_encoding' in marks


def test_regional_long_prompt_real_pipeline(pipe):
    from test_diffusers_cpu import mask
    req=dict(regions=[dict(enabled=True,mask=mask(0,32),trigger='a',prompt='bat, '*40,negative_prompt='fox '*40)],width=32,height=32,cfg_scale=5,prompt='park',negative_prompt='bad')
    with torch.no_grad(),regional_routing(pipe,req,[],[[('a',1.15)]],lambda *args:None):
        values=encode_long_prompt(pipe,'park','bad')
        result=pipe(**dict(zip(('prompt_embeds','negative_prompt_embeds','pooled_prompt_embeds','negative_pooled_prompt_embeds'),values)),width=32,height=32,num_inference_steps=2,guidance_scale=5,output_type='latent').images
        assert torch.isfinite(result).all()
    assert not pipe.unet._forward_hooks


def test_native_truncation_with_real_sdxl_tokenizers(pipe):
    fixtures=Path(__file__).parent/'fixtures'
    example=json.loads((fixtures/'token-audit.json').read_text())
    for i,encoder in enumerate([pipe.text_encoder,pipe.text_encoder_2]):
        tokenizer=CLIPTokenizer.from_pretrained(fixtures/'tokenizers'/('tokenizer' if i==0 else 'tokenizer_2'))
        setattr(pipe,'tokenizer' if i==0 else 'tokenizer_2',tokenizer)
        encoder.resize_token_embeddings(len(tokenizer))
        encoder.config.eos_token_id=tokenizer.eos_token_id
    seen=[[],[]]
    hooks=[encoder.register_forward_pre_hook(lambda m,args,i=i:seen[i].append(args[0].clone())) for i,encoder in enumerate([pipe.text_encoder,pipe.text_encoder_2])]
    with torch.no_grad():native=pipe.encode_prompt(example['positive'],negative_prompt=example['negative'])
    for hook in hooks:hook.remove()
    plan=token_plan(pipe,example['positive'],example['negative'])
    for row,windows in zip(plan['encoders'],seen):
        assert row['positive']['content_tokens']==105 and row['negative']['content_tokens']==141
        assert all(w.shape==(1,77) for w in windows)
    fixed=encode_long_prompt(pipe,example['positive'],example['negative'])
    assert native[0].shape==(1,77,16) and fixed[0].shape==(1,154,16)
    torch.testing.assert_close(native[0],fixed[0][:,:77],rtol=0,atol=0)
    torch.testing.assert_close(native[2],fixed[2],rtol=0,atol=0)
