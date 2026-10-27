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

def mask(left,right):
    im=Image.new('L',(32,32));im.paste(255,(left,0,right,32));b=io.BytesIO();im.save(b,format='PNG');return 'data:image/png;base64,'+base64.b64encode(b.getvalue()).decode()
class RealFrameworkTest(unittest.TestCase):
    def test_sdxl_peft_routing_all_samplers_and_cleanup(self):
        torch.set_num_threads(2);torch.manual_seed(7)
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);vocab={'<|startoftext|>':0,'<|endoftext|>':1}
            for c in 'abcdefghijklmnopqrstuvwxyz':vocab[c]=len(vocab);vocab[c+'</w>']=len(vocab)
            (root/'vocab.json').write_text(json.dumps(vocab));(root/'merges.txt').write_text('#version: 0.2\n')
            tokenizer=CLIPTokenizer(vocab_file=str(root/'vocab.json'),merges_file=str(root/'merges.txt'),model_max_length=16)
            config=CLIPTextConfig(vocab_size=len(vocab),hidden_size=8,intermediate_size=16,num_hidden_layers=2,num_attention_heads=2,max_position_embeddings=16,projection_dim=8,bos_token_id=0,eos_token_id=1,pad_token_id=1)
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
            regions=[dict(enabled=True,mask=mask(0,16),trigger='a',prompt='bat',negative_prompt='fox'),dict(enabled=True,mask=mask(16,32),trigger='b',prompt='fox',negative_prompt='bat')]
            req=dict(regions=regions,width=32,height=32,cfg_scale=5,prompt='park',negative_prompt='bad')
            seen=[]
            observer=unet.register_forward_pre_hook(lambda m,args:seen.append(tuple(m.active_adapters())))
            for scheduler in [EulerDiscreteScheduler,DPMSolverMultistepScheduler,EulerAncestralDiscreteScheduler]:
                pipe.scheduler=scheduler.from_config(pipe.scheduler.config);steps=[]
                with torch.no_grad(),regional_routing(pipe,req,[],[[('a',.6)],[('b',1.2)]],lambda *a:None):
                    image=pipe(prompt='park',negative_prompt='bad',width=32,height=32,num_inference_steps=3,guidance_scale=5,output_type='latent',generator=torch.Generator().manual_seed(2),callback_on_step_end=lambda p,i,t,d:(steps.append(i) or d)).images
                self.assertEqual(image.shape,(1,4,4,4));self.assertTrue(torch.isfinite(image).all());self.assertEqual(steps,[0,1,2]);self.assertFalse(unet._forward_hooks)
            self.assertIn(('a',),seen);self.assertIn(('b',),seen);observer.remove()
            # Subsequent ordinary generation must execute after hook removal.
            select_adapters(pipe,[],True)
            result=pipe(prompt='park',width=32,height=32,num_inference_steps=1,output_type='latent').images
            self.assertTrue(torch.isfinite(result).all())
if __name__=='__main__':unittest.main()
