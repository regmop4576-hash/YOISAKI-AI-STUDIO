import {sanitize} from './cc-diagnostics.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PROVIDERS,endpoint} from './providers.mjs';
// v1.7.3 secrets of the local app, kept apart from state.json (which stays credential-free):
//  - remembered GPU connections (origin + engine token), only after the user ticks «Запомнить»;
//  - the user's own Google OAuth client (Desktop app) for the browser Drive authorization;
//  - v1.7.5: the automatic CloudCompute deployment (instance ID, its engine token and the observed stages).
// The file is 0600 in the 0700 data folder (Termux app-private storage on Android). Nothing here is ever
// returned to the page: publicView() exposes origins and flags only.
const EMPTY=()=>({version:1,connections:{},google:null,cloud_key:null,drive:null,deployment:null});
const TOKEN=/^[a-f0-9]{64}$/;
export const CLIENT_ID_RE=/^[0-9]{6,30}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$/;
export const CLIENT_SECRET_RE=/^[A-Za-z0-9_-]{10,100}$/;
const STAGE=/^[A-Z_]{3,30}$/,short=(v,n)=>typeof v==='string'?v.replace(/[\x00-\x1f]/g,' ').slice(0,n):'';
function cleanDeployment(d){
 if(!d||typeof d!=='object'||!/^[A-Za-z0-9_-]{1,100}$/.test(d.instance_id)||!TOKEN.test(d.token)||typeof d.image!=='string'||d.image.length>255)return null;
 const offer=d.offer&&typeof d.offer==='object'?{id:Number.isSafeInteger(d.offer.id)?d.offer.id:null,gpu:short(d.offer.gpu,120),vram_mb:Number.isFinite(d.offer.vram_mb)?d.offer.vram_mb:null,price_minor:Number.isSafeInteger(d.offer.price_minor)?d.offer.price_minor:null,currency:/^[A-Z]{3}$/.test(d.offer.currency)?d.offer.currency:''}:null;
 let url=null;try{const u=new URL(d.url);if(u.protocol==='https:'&&u.pathname==='/'&&!u.search&&!u.hash&&u.origin===d.url)url=d.url}catch{}
 return {instance_id:d.instance_id,token:d.token,image:d.image,name:short(d.name,255),created_at:Number(d.created_at)||Date.now(),adopted:d.adopted===true,offer,disk_gb:Number.isSafeInteger(d.disk_gb)?d.disk_gb:null,auto_sync:d.auto_sync===true,
  stage:STAGE.test(d.stage)?(d.stage==='INSTANCE_INITIALIZING'?'PROVIDER_BOOTSTRAPPING':d.stage):'GPU_CREATED',stage_message:short(d.stage_message,600),stage_at:Number(d.stage_at)||null,error:short(d.error,600),instance_status:short(d.instance_status,60),url,
  gpu_stages:Array.isArray(d.gpu_stages)?d.gpu_stages.filter(x=>STAGE.test(x?.stage)&&Number.isInteger(x?.ts)).slice(-8).map(x=>({stage:x.stage,ts:x.ts})):[],
  drive:d.drive&&typeof d.drive==='object'?JSON.parse(JSON.stringify(d.drive,(k,v)=>typeof v==='string'?v.slice(0,600):v)):null,
  // v1.7.7: verified-stage evidence. Only short, credential-free strings and numbers are kept.
  initialization:d.initialization&&typeof d.initialization==='object'?sanitize(d.initialization):null,provider:cleanProvider(d.provider),failure:cleanFailure(d.failure),
  stage_history:Array.isArray(d.stage_history)?d.stage_history.filter(h=>STAGE.test(h?.stage)&&Number.isFinite(h?.at)).slice(-40).map(h=>({stage:h.stage,at:h.at,source:/^(app|cloudcompute|engine|health)$/.test(h.source)?h.source:'app',provider_status:short(h.provider_status,60)})):[],
  last_verified_stage:STAGE.test(d.last_verified_stage)?d.last_verified_stage:null,
  bootstrap_profile:/^(worker|access_only|full|none|provider_default)$/.test(d.bootstrap_profile)?d.bootstrap_profile:null,
  terminal:d.terminal&&/^(AVAILABLE|UNAVAILABLE|UNKNOWN)$/.test(d.terminal.state)?{state:d.terminal.state,message:short(d.terminal.message,300),checked_at:Number(d.terminal.checked_at)||null}:null,
  request_id:/^[A-Za-z0-9-]{8,64}$/.test(d.request_id)?d.request_id:null};
}
const scrub=v=>short(v,400).replace(/[a-f0-9]{64}/gi,'[СКРЫТО]').replace(/cc-[A-Za-z0-9._~-]{8,}/g,'[СКРЫТО]');
function cleanProvider(p){
 if(!p||typeof p!=='object')return null;
 const fields={};if(p.fields&&typeof p.fields==='object')for(const [k,v] of Object.entries(p.fields).slice(0,12))if(/^[a-z_]{2,30}$/.test(k)&&typeof v==='string')fields[k]=scrub(v);
 return {status:short(p.status,60),raw_status:typeof p.raw_status==='number'?p.raw_status:scrub(p.raw_status),fields,phase:/^(UNKNOWN|CREATE|BOOT|IMAGE|RUNNING|STOPPED|FAILED|GONE)$/.test(p.phase)?p.phase:'UNKNOWN',message:scrub(p.message),checked_at:Number(p.checked_at)||null};
}
function cleanFailure(f){
 if(!f||typeof f!=='object'||!/^[a-z_]{2,20}$/.test(f.component))return null;
 return {component:f.component,code:/^[A-Z0-9_]{2,40}$/.test(f.code)?f.code:'UNKNOWN',message:scrub(f.message),provider_status:short(f.provider_status,60),terminal:f.terminal===true,at:Number(f.at)||null};
}
function clean(raw){
 const data=EMPTY();
 if(!raw||typeof raw!=='object')return data;
 for(const p of PROVIDERS){
  const c=raw.connections?.[p];
  try{if(c&&TOKEN.test(c.token)&&endpoint(c.origin,p)===c.origin)data.connections[p]={origin:c.origin,token:c.token,saved_at:Number(c.saved_at)||Date.now(),discover:c.discover===true}}catch{}
 }
 const g=raw.google;
 if(g&&CLIENT_ID_RE.test(g.client_id)&&CLIENT_SECRET_RE.test(g.client_secret))data.google={client_id:g.client_id,client_secret:g.client_secret};
 if(typeof raw.cloud_key==='string'&&/^cc-[A-Za-z0-9._~-]{8,500}$/.test(raw.cloud_key))data.cloud_key=raw.cloud_key;
 const d=raw.drive;
 if(d&&typeof d.token?.access_token==='string'&&typeof d.token?.refresh_token==='string'&&CLIENT_ID_RE.test(d.client?.client_id)&&CLIENT_SECRET_RE.test(d.client?.client_secret))data.drive={session_id:d.session_id,token:d.token,client:d.client,account:d.account||{},folder:d.folder||null};
 data.deployment=cleanDeployment(raw.deployment);
 return data;
}
export class SecretStore{
 constructor(dir){this.file=path.join(dir,'secrets.json');this.chain=Promise.resolve();this.data=EMPTY();this.warning=''}
 async init(){
  try{this.data=clean(JSON.parse(await fs.readFile(this.file,'utf8')));await fs.chmod(this.file,0o600)}
  catch(e){if(e.code!=='ENOENT'){this.data=EMPTY();this.warning='Файл сохранённых подключений повреждён: подключения нужно запомнить заново.';await fs.rename(this.file,this.file+'.damaged-'+Date.now()).catch(()=>{})}}
  return this;
 }
 change(fn){
  const task=this.chain.then(async()=>{
   const next=structuredClone(this.data);fn(next);const bytes=JSON.stringify(clean(next));
   const temp=this.file+'.tmp-'+randomUUID();let h;
   try{h=await fs.open(temp,'wx',0o600);await h.writeFile(bytes);await h.sync();await h.close();h=null;await fs.rename(temp,this.file)}
   finally{if(h)await h.close();await fs.rm(temp,{force:true}).catch(()=>{})}
   this.data=JSON.parse(bytes);
  });
  this.chain=task.catch(()=>{});return task;
 }
 connection(provider){return this.data.connections[provider]||null}
 remember(provider,{origin,token,discover}){return this.change(d=>{const old=d.connections[provider];d.connections[provider]={origin,token,saved_at:Date.now(),discover:discover??old?.discover??false}})}
 forget(provider){return this.change(d=>{delete d.connections[provider]})}
 setDiscover(provider,value){return this.change(d=>{if(d.connections[provider])d.connections[provider].discover=value===true})}
 cloudKey(){return this.data.cloud_key}
 setCloudKey(value){return this.change(d=>{d.cloud_key=value})}
 drive(){return this.data.drive}
 setDrive(value){return this.change(d=>{d.drive=value})}
 deployment(){return this.data.deployment}
 setDeployment(value){return this.change(d=>{d.deployment=value})}
 google(){return this.data.google}
 setGoogle(value){return this.change(d=>{d.google=value})}
 publicView(){
  const out={};for(const p of PROVIDERS){const c=this.data.connections[p];out[p]=c?{origin:c.origin,saved_at:c.saved_at,discover:c.discover}:null}
  return out;
 }
}
