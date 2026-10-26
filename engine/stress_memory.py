"""Opt-in REAL engine stress test. Sends no requests without a CUDA-ready engine.
Called from notebook with token passed in memory, never CLI or output.
"""
import time,uuid,json
from pathlib import Path
import requests

def run(token,checkpoint_id,character_id='',second_character_id='',style_id='',width=768,height=768,steps=20,trigger_a='',trigger_b='',prompt='two characters in a park',base='http://127.0.0.1:8765',output='/content/drive/MyDrive/YOISAKI_AI_STUDIO/diagnostics/stress'):
    session=requests.Session();session.headers['Authorization']='Bearer '+token
    def call(method,path,**kw):
        r=session.request(method,base+path,timeout=120,**kw);r.raise_for_status();return r
    health=call('GET','/health').json()
    if health.get('engine_version')!='1.7.0' or not health.get('gpu_name') or health.get('state')!='READY':raise RuntimeError('Ready CUDA engine 1.7.0 required; no simulation performed')
    out=Path(output);out.mkdir(parents=True,exist_ok=True)
    scenarios=[('off_'+str(i+1),[],[]) for i in range(10)]
    if character_id:scenarios.append(('character',[{'id':character_id,'weight':.8}],[]))
    if character_id and second_character_id:
        import io,base64
        from PIL import Image
        regions=[]
        for i,(ident,trigger) in enumerate([(character_id,trigger_a),(second_character_id,trigger_b)]):
            im=Image.new('L',(width,height));im.paste(255,(i*width//2,0,(i+1)*width//2,height));buf=io.BytesIO();im.save(buf,format='PNG');im.close()
            regions.append(dict(name='region '+str(i),enabled=True,lora_id=ident,trigger=trigger,prompt='character '+str(i+1),negative_prompt='',weight=.8,mask='data:image/png;base64,'+base64.b64encode(buf.getvalue()).decode()))
            buf.close()
        scenarios.append(('regional_two',[],regions))
    if style_id:scenarios.append(('style',[{'id':style_id,'weight':.8}],[]))
    try:
        for label,loras,regions in scenarios:
            body=dict(client_request_id=str(uuid.uuid4()),kind='text2img',mode='text2img',prompt=prompt,negative_prompt='',checkpoint_id=checkpoint_id,vae_id='auto',lora_adapters=loras,regions=regions,width=width,height=height,steps=steps,cfg_scale=5,sampler='Euler',scheduler='Normal',seed=123,batch_size=1,controlnet_config={'enabled':False})
            job=call('POST','/generate',json=body).json()['id'];deadline=time.monotonic()+3600
            while True:
                status=call('GET','/jobs/'+job).json()
                if status['status'] in ('FAILED','CANCELLED'):raise RuntimeError('Stress stopped: '+status['status'])
                if status['status']=='COMPLETED':break
                if time.monotonic()>deadline:
                    call('DELETE','/jobs/'+job);raise TimeoutError('Stress job timeout; cancelled')
                time.sleep(2)
            # Stream the real PNG to Drive before ACK. No test image is synthesized here.
            with call('GET','/results/'+job+'?index=0',stream=True) as response:
                with (out/(label+'.png')).open('wb') as f:
                    for block in response.iter_content(65536):f.write(block)
            call('POST','/jobs/'+job+'/ack',json={})
            # Status is COMPLETED slightly before finally cleanup; wait for matching sample.
            for _ in range(60):
                measured=call('GET','/memory').json()
                if measured.get('last',{}).get('job_id')==job and measured['last']['phase']=='after_cleanup':break
                time.sleep(1)
            else:raise RuntimeError('No completed cleanup measurement; cannot compare memory')
            with (out/'summary.jsonl').open('a') as f:f.write(json.dumps({'scenario':label,**measured['last']})+'\n')
            print(label,'RSS bytes:',measured['last']['process_rss_bytes'],'CUDA allocated:',measured['last']['cuda_allocated_bytes'])
    finally:session.close()
