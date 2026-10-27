import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PROVIDERS,endpoint} from './providers.mjs';
// v1.7.3 secrets of the local app, kept apart from state.json (which stays credential-free):
//  - remembered GPU connections (origin + engine token), only after the user ticks «Запомнить»;
//  - the user's own Google OAuth client (Desktop app) for the browser Drive authorization.
// The file is 0600 in the 0700 data folder (Termux app-private storage on Android). Nothing here is ever
// returned to the page: publicView() exposes origins and flags only.
const EMPTY=()=>({version:1,connections:{},google:null});
const TOKEN=/^[a-f0-9]{64}$/;
export const CLIENT_ID_RE=/^[0-9]{6,30}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$/;
export const CLIENT_SECRET_RE=/^[A-Za-z0-9_-]{10,100}$/;
function clean(raw){
 const data=EMPTY();
 if(!raw||typeof raw!=='object')return data;
 for(const p of PROVIDERS){
  const c=raw.connections?.[p];
  try{if(c&&TOKEN.test(c.token)&&endpoint(c.origin,p)===c.origin)data.connections[p]={origin:c.origin,token:c.token,saved_at:Number(c.saved_at)||Date.now(),discover:c.discover===true}}catch{}
 }
 const g=raw.google;
 if(g&&CLIENT_ID_RE.test(g.client_id)&&CLIENT_SECRET_RE.test(g.client_secret))data.google={client_id:g.client_id,client_secret:g.client_secret};
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
 publicView(){
  const out={};for(const p of PROVIDERS){const c=this.data.connections[p];out[p]=c?{origin:c.origin,saved_at:c.saved_at,discover:c.discover}:null}
  return out;
 }
}
