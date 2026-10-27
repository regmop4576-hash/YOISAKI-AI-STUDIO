import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PROVIDERS,endpoint} from './providers.mjs';
import {KEY_RE,INSTANCE_ID_RE} from './cloudcompute-api.mjs';
// v1.7.3 secrets of the local app, kept apart from state.json (which stays credential-free):
//  - remembered GPU connections (origin + engine token), only after the user ticks «Запомнить»;
//  - the user's own Google OAuth client (Desktop app) for the browser Drive authorization;
//  - the CloudCompute REST API key and the selected instance (never sent to the page, the GPU engine or logs);
//  - the Google Drive link: refresh token, account, chosen model folder (refresh token never leaves this file
//    except to Google and, for the sync itself, to the user's own GPU server).
// The file is 0600 in the 0700 data folder (Termux app-private storage on Android). Nothing here is ever
// returned to the page: publicView() exposes origins and flags only.
const EMPTY=()=>({version:1,connections:{},google:null,cloudcompute:null,drive:null});
const TOKEN=/^[a-f0-9]{64}$/;
export const CLIENT_ID_RE=/^[0-9]{6,30}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$/;
export const CLIENT_SECRET_RE=/^[A-Za-z0-9_-]{10,100}$/;
export const REFRESH_RE=/^[A-Za-z0-9._\/-]{10,2048}$/;
const FOLDER_RE=/^[A-Za-z0-9_-]{10,200}$/;
const txt=(v,max)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,max):'';
function clean(raw){
 const data=EMPTY();
 if(!raw||typeof raw!=='object')return data;
 for(const p of PROVIDERS){
  const c=raw.connections?.[p];
  try{if(c&&TOKEN.test(c.token)&&endpoint(c.origin,p)===c.origin)data.connections[p]={origin:c.origin,token:c.token,saved_at:Number(c.saved_at)||Date.now(),discover:c.discover===true}}catch{}
 }
 const g=raw.google;
 if(g&&CLIENT_ID_RE.test(g.client_id)&&CLIENT_SECRET_RE.test(g.client_secret))data.google={client_id:g.client_id,client_secret:g.client_secret};
 const cc=raw.cloudcompute;
 if(cc&&KEY_RE.test(cc.api_key))data.cloudcompute={api_key:cc.api_key,saved_at:Number(cc.saved_at)||Date.now(),validated_at:Number(cc.validated_at)||null,instance_id:typeof cc.instance_id==='string'&&INSTANCE_ID_RE.test(cc.instance_id)?cc.instance_id:null};
 const d=raw.drive;
 if(d&&REFRESH_RE.test(d.refresh_token)&&CLIENT_ID_RE.test(d.client_id)&&['own','public'].includes(d.client)){
  const f=d.folder&&FOLDER_RE.test(d.folder.id)?{id:d.folder.id,name:txt(d.folder.name,200),path:txt(d.folder.path,400),root:d.folder.root==='other'?'other':'my'}:null;
  const p=d.provisioned&&typeof d.provisioned.origin==='string'?{origin:d.provisioned.origin.slice(0,300),linked_at:Number(d.provisioned.linked_at)||0,folder_id:typeof d.provisioned.folder_id==='string'?d.provisioned.folder_id.slice(0,200):''}:null;
  data.drive={refresh_token:d.refresh_token,client:d.client,client_id:d.client_id,linked_at:Number(d.linked_at)||Date.now(),account:d.account?{email:txt(d.account.email,120),name:txt(d.account.name,120)}:null,folder:f,
   auto_provision:d.auto_provision!==false,auto_sync:d.auto_sync===true,reauth:d.reauth===true,provisioned:p};
 }
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
 google(){return this.data.google}
 setGoogle(value){return this.change(d=>{d.google=value})}
 cloudcompute(){return this.data.cloudcompute}
 setCloudCompute(patch){return this.change(d=>{d.cloudcompute=patch===null?null:{...d.cloudcompute,...patch}})}
 drive(){return this.data.drive}
 setDrive(patch){return this.change(d=>{d.drive=patch===null?null:{...d.drive,...patch}})}
 // What the page may see about the Drive link: never the refresh token.
 driveView(){const d=this.data.drive;return d?{linked:true,client:d.client,account:d.account,folder:d.folder,linked_at:d.linked_at,auto_provision:d.auto_provision,auto_sync:d.auto_sync,reauth:d.reauth,provisioned_origin:d.provisioned?.origin||null}:{linked:false}}
 publicView(){
  const out={};for(const p of PROVIDERS){const c=this.data.connections[p];out[p]=c?{origin:c.origin,saved_at:c.saved_at,discover:c.discover}:null}
  return out;
 }
}
