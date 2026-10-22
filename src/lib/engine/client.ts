import type {EngineAdapter,EngineStatus,EngineModel,GenerationRequest,GenerationJob,EngineCapabilities,EngineTelemetry} from './types';
import {api,LiveEngine} from './live';
export class ConnectedEngineAdapter implements EngineAdapter {
 async active():Promise<LiveEngine|null>{const d=await api<{engines:LiveEngine[]}>('engines');return d.engines.find(e=>e.state==='READY'||e.state==='BUSY')||null}
 async getStatus():Promise<EngineStatus>{try{return (await this.active())?.state as EngineStatus||'OFFLINE'}catch{return 'OFFLINE'}}
 async getCapabilities():Promise<EngineCapabilities>{return {samplers:['Euler','Euler a','DPM++ 2M'],schedulers:['Normal','Karras'],maxWidth:1536,maxHeight:1536,img2img:false,inpaint:false,controlNet:false}}
 async listModels():Promise<EngineModel[]>{const e=await this.active();return (e?.models||[]).map(m=>({...m,available:true}))}
 async submitGeneration(req:GenerationRequest):Promise<GenerationJob>{const e=await this.active();if(!e)throw Error('GPU отключён');const x=await api<{id:string;status:GenerationJob['status']}>('jobs',{method:'POST',body:JSON.stringify({engine_id:e.id,request:{kind:'text2img',mode:'text2img',prompt:req.prompt,negative_prompt:req.negativePrompt,checkpoint_id:req.checkpoint,vae_id:'auto',lora_adapters:[],width:req.width,height:req.height,steps:req.steps,cfg_scale:req.cfg,seed:req.seed??-1,batch_size:1,sampler:req.sampler,scheduler:req.scheduler,controlnet_config:{enabled:false}}})});return x}
 async getJobStatus(id:string):Promise<GenerationJob>{const x=await api<{id:string;status:GenerationJob['status'];progress?:{percent:number;step:number;total_steps:number;stage:string};error?:string}>('jobs?id='+encodeURIComponent(id));return {id:x.id,status:x.status,progress:x.progress?.percent,stage:x.progress?.stage,completedSteps:x.progress?.step,totalSteps:x.progress?.total_steps,error:x.error}}
 async cancelJob(id:string):Promise<void>{await api('jobs',{method:'DELETE',body:JSON.stringify({id})})}
 async getResult(id:string):Promise<Blob|null>{const r=await fetch('/api/connect/result?id='+encodeURIComponent(id)+'&index=0');return r.ok?r.blob():null}
 async getTelemetry():Promise<EngineTelemetry|null>{const e=await this.active();return e?{gpuName:e.telemetry?.gpu_name,provider:e.provider,vramTotalMB:e.telemetry?.vram_total_mb}:null}
}
export const engineClient:EngineAdapter=new ConnectedEngineAdapter();
