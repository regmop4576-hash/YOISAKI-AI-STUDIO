'use client';
import {create} from 'zustand';
import type {LiveModel} from './live';
import {localApi} from '../local-api';
export type Provider='colab'|'cloudcompute';
export type DirectStatus='OFFLINE'|'CONNECTING'|'READY'|'BUSY'|'LOADING'|'ERROR';
type EngineInfo={gpu_name:string|null;vram_total_mb:number|null;vram_available_mb:number|null;engine_version:string;api_version?:string;state:DirectStatus};
// v1.7.3: connection phase, component diagnostics, model-list health and remembered servers (origins only, never tokens).
export type Phase='OFFLINE'|'STARTING'|'CONNECTING'|'AUTHENTICATING'|'LOADING'|'READY'|'ERROR';
export type ComponentState='READY'|'WAITING'|'WARNING'|'ERROR'|'UNKNOWN';
export type Remembered={origin:string;saved_at:number;discover:boolean}|null;
export type RejectedModel={name:string;kind:string|null;reason:string};
// v1.7.3 CONNECT GPU: provider (CloudCompute API instance) progress, separate from the engine connection phases.
export type GpuFlow={api:boolean;step:'NO_API'|'INSTANCE_CHECK'|'INSTANCE_STARTING'|'INSTANCE_RUNNING'|'READY'|'ERROR';instance_id:string|null;instance_status:string|null;provider_status:string;instance_name:string};
export type DriveGpu={state:'IDLE'|'RUNNING'|'DONE'|'SYNCING'|'ERROR';message:string;code:string;at:number|null;origin:string|null};
type Snapshot={code?:string;provider:Provider;endpoints:Record<Provider,string>;website_version?:string;compatible_engine_family?:string;compatibility?:string;url:string;state:DirectStatus;info:EngineInfo|null;models:LiveModel[];error:string;
 phase?:Phase;phase_message?:string;components?:Record<'frontend'|'tunnel'|'auth'|'engine'|'gpu'|'models',ComponentState>;
 models_updated_at?:number|null;models_origin?:string|null;models_rejected?:RejectedModel[];models_error?:string;models_code?:string;models_stale?:boolean;
 connected_at?:number|null;remembered?:Record<Provider,Remembered>;autoconnect?:{attempt:number;started_at:number;deadline:number;origin:string}|null;rendezvous_host?:string;secrets_warning?:string;
 gpu_flow?:GpuFlow|null;cloudcompute_api?:{configured:boolean;instance_id:string|null;available:boolean};drive_link?:{linked:boolean;reauth:boolean;folder:boolean};drive_gpu?:DriveGpu};
type State=Snapshot&{token:string;changing:boolean;set:(x:Partial<Snapshot>)=>void;connect:(raw:string,options?:{remember?:boolean;discover?:boolean})=>Promise<void>;selectProvider:(provider:Provider,endpoint:string)=>Promise<void>;disconnect:()=>Promise<void>;refresh:(models?:boolean)=>Promise<void>;
 connectSaved:()=>Promise<void>;connectGpu:(startInstance?:boolean)=>Promise<void>;poll:()=>Promise<void>;updateSaved:(change:{forget?:boolean;discover?:boolean})=>Promise<void>};
let revision=0;
export const useDirect=create<State>((set,get)=>({provider:'colab',endpoints:{colab:'',cloudcompute:''},url:'',token:'',changing:false,state:'OFFLINE',info:null,models:[],error:'',set:x=>set(x),
 selectProvider:async(provider,endpoint)=>{const rev=++revision;set({changing:true,error:''});try{const snap=await localApi<Snapshot>('/api/gpu/provider',{method:'POST',body:JSON.stringify({provider,endpoint})});if(rev===revision)set(snap)}catch(e){if(rev===revision)set({error:(e as Error).message,code:(e as Error & {code?:string}).code});throw e}finally{if(rev===revision)set({changing:false})}},
 disconnect:async()=>{const rev=++revision;set({changing:true});try{const snap=await localApi<Snapshot>('/api/gpu/disconnect',{method:'POST'});if(rev===revision)set(snap)}catch(e){if(rev===revision)set({error:(e as Error).message})}finally{if(rev===revision)set({changing:false})}},
 connect:async(raw,options={})=>{const rev=++revision;const provider=get().provider;set({state:'CONNECTING',phase:'CONNECTING',phase_message:'Подключаюсь…',info:null,url:'',error:''});try{const snap=await localApi<Snapshot>('/api/gpu/connect',{method:'POST',body:JSON.stringify({url:raw,provider,...options})});if(rev===revision)set(snap)}catch(e){if(rev===revision)set({state:'ERROR',info:null,error:(e as Error).message,code:(e as Error & {code?:string}).code});throw e}},
 refresh:async(models=false)=>{const rev=revision;if(get().changing||get().state==='CONNECTING')return;try{const snap=await localApi<Snapshot>('/api/gpu/status'+(models?'?models=1':''));if(rev===revision)set(snap)}catch(e){if(rev===revision)set({state:'ERROR',info:null,error:(e as Error).message})}},
 // One click with a remembered server: the local server keeps trying while the GPU boots; poll() follows its phases.
 connectSaved:async()=>{const rev=++revision;set({state:'CONNECTING',phase:'CONNECTING',phase_message:'Подключаюсь к сохранённому серверу…',error:'',code:undefined});try{const snap=await localApi<Snapshot>('/api/gpu/autoconnect',{method:'POST',body:JSON.stringify({provider:get().provider})});if(rev===revision)set(snap)}catch(e){if(rev===revision)set({state:'ERROR',phase:'ERROR',error:(e as Error).message,code:(e as Error & {code?:string}).code});throw e}},
 // v1.7.3 CONNECT GPU (CloudCompute): instance via API (start only when confirmed) → remembered engine link.
 connectGpu:async(startInstance=false)=>{const rev=++revision;set({state:'CONNECTING',phase:'STARTING',phase_message:'',error:'',code:undefined});try{const snap=await localApi<Snapshot>('/api/gpu/connect-gpu',{method:'POST',body:JSON.stringify({start_instance:startInstance})});if(rev===revision)set(snap)}catch(e){if(rev===revision)set({state:'ERROR',phase:'ERROR',error:(e as Error).message,code:(e as Error & {code?:string}).code});throw e}},
 poll:async()=>{const rev=revision;try{const snap=await localApi<Snapshot>('/api/gpu/status');if(rev===revision)set(snap)}catch{}},
 updateSaved:async change=>{const snap=await localApi<Snapshot>('/api/gpu/remembered',{method:'POST',body:JSON.stringify({provider:get().provider,...change})});set(snap)}
}));
// Compatibility signature: the browser never holds an active session credential.
export async function directFetch<T>(_url:string,_token:string,path:string,init:RequestInit={}):Promise<T>{return localApi<T>('/api/gpu/'+path,init)}
export async function imageFromDirect(_url:string,_token:string,id:string,index:number){return '/api/gallery/'+encodeURIComponent(id+'_'+index)+'/file'}
