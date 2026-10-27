'use client';
import {create} from 'zustand';
import type {LiveModel} from './live';
import {localApi} from '../local-api';
export type Provider='colab'|'cloudcompute';
export type DirectStatus='OFFLINE'|'CONNECTING'|'READY'|'BUSY'|'LOADING'|'ERROR';
type EngineInfo={gpu_name:string|null;vram_total_mb:number|null;vram_available_mb:number|null;engine_version:string;api_version?:string;state:DirectStatus};
type Snapshot={code?:string;provider:Provider;endpoints:Record<Provider,string>;website_version?:string;compatible_engine_family?:string;compatibility?:string;url:string;state:DirectStatus;info:EngineInfo|null;models:LiveModel[];error:string};
type State=Snapshot&{token:string;changing:boolean;set:(x:Partial<Snapshot>)=>void;connect:(raw:string)=>Promise<void>;selectProvider:(provider:Provider,endpoint:string)=>Promise<void>;disconnect:()=>Promise<void>;refresh:(models?:boolean)=>Promise<void>};
let revision=0;
export const useDirect=create<State>((set,get)=>({provider:'colab',endpoints:{colab:'',cloudcompute:''},url:'',token:'',changing:false,state:'OFFLINE',info:null,models:[],error:'',set:x=>set(x),
 selectProvider:async(provider,endpoint)=>{const rev=++revision;set({changing:true,error:''});try{const snap=await localApi<Snapshot>('/api/gpu/provider',{method:'POST',body:JSON.stringify({provider,endpoint})});if(rev===revision)set(snap)}catch(e){if(rev===revision)set({error:(e as Error).message,code:(e as Error & {code?:string}).code});throw e}finally{if(rev===revision)set({changing:false})}},
 disconnect:async()=>{const rev=++revision;set({changing:true});try{const snap=await localApi<Snapshot>('/api/gpu/disconnect',{method:'POST'});if(rev===revision)set(snap)}catch(e){if(rev===revision)set({error:(e as Error).message})}finally{if(rev===revision)set({changing:false})}},
 connect:async raw=>{const rev=++revision;const provider=get().provider;set({state:'CONNECTING',info:null,url:'',error:''});try{const snap=await localApi<Snapshot>('/api/gpu/connect',{method:'POST',body:JSON.stringify({url:raw,provider})});if(rev===revision)set(snap)}catch(e){if(rev===revision)set({state:'ERROR',info:null,error:(e as Error).message,code:(e as Error & {code?:string}).code});throw e}},
 refresh:async(models=false)=>{const rev=revision;if(get().changing||get().state==='CONNECTING')return;try{const snap=await localApi<Snapshot>('/api/gpu/status'+(models?'?models=1':''));if(rev===revision)set(snap)}catch(e){if(rev===revision)set({state:'ERROR',info:null,error:(e as Error).message})}}
}));
// Compatibility signature: the browser never holds an active session credential.
export async function directFetch<T>(_url:string,_token:string,path:string,init:RequestInit={}):Promise<T>{return localApi<T>('/api/gpu/'+path,init)}
export async function imageFromDirect(_url:string,_token:string,id:string,index:number){return '/api/gallery/'+encodeURIComponent(id+'_'+index)+'/file'}
