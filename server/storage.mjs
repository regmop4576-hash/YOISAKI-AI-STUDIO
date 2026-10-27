import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pruneHistory} from './history.mjs';
import {fail} from './errors.mjs';
import {compactControlRequest} from './controlnet.mjs';
export class Store{
 constructor(dir){this.dir=dir;this.file=path.join(dir,'state.json');this.chain=Promise.resolve();this.warning=''}
 async init(){await fs.mkdir(path.join(this.dir,'images'),{recursive:true,mode:0o700});
 const valid=x=>x&&x.version===1&&Array.isArray(x.models)&&Array.isArray(x.gallery)&&Array.isArray(x.history)&&x.tags&&typeof x.tags==='object';
 try{this.data=JSON.parse(await fs.readFile(this.file,'utf8'));if(!valid(this.data))throw Error('schema')}
 catch(e){if(e.code==='ENOENT'){this.data={version:1,settings:null,models:[],tags:{},gallery:[],history:[],preferences:{}};await this.atomic(this.file,JSON.stringify(this.data))}
 else{try{this.data=JSON.parse(await fs.readFile(this.file+'.bak','utf8'));if(!valid(this.data))throw Error('backup schema');await fs.copyFile(this.file,this.file+'.damaged-'+Date.now());await this.atomic(this.file,JSON.stringify(this.data));this.warning='Хранилище восстановлено из резервной копии.'}catch{fail('STORAGE_CORRUPT','Повреждены данные и резервная копия. Файлы сохранены; восстановите state.json из резервной копии.',500)}}}
 // AUD-002 migration of v1.6.0 data: records are kept; only embedded base64 control maps become digests.
 // The untouched original is saved once as state.json.v1.6.0-backup.
 const bloated=x=>typeof x?.controlnet_config?.image==='string';
 if(this.data.history.some(j=>bloated(j?.request))||this.data.gallery.some(g=>bloated(g?.parameters))){
  const backup=this.file+'.v1.6.0-backup';
  if(!await fs.access(backup).then(()=>true,()=>false))await this.atomic(backup,JSON.stringify(this.data));
  await this.change(d=>{for(const j of d.history)if(bloated(j?.request))j.request=compactControlRequest(j.request);for(const g of d.gallery)if(bloated(g?.parameters))g.parameters=compactControlRequest(g.parameters)});
 }
 if(pruneHistory(this.data.history)!==this.data.history)await this.change(()=>{});
 return this;
 }
 async atomic(file,bytes){const temp=file+'.tmp-'+randomUUID();let h;try{h=await fs.open(temp,'wx',0o600);await h.writeFile(bytes);await h.sync();await h.close();h=null;await fs.rename(temp,file);try{const d=await fs.open(path.dirname(file),'r');await d.sync();await d.close()}catch{}}finally{if(h)await h.close();await fs.rm(temp,{force:true}).catch(()=>{})}}
 change(fn){const task=this.chain.then(async()=>{const next=structuredClone(this.data);const result=await fn(next);next.history=pruneHistory(next.history);const current=JSON.stringify(this.data),bytes=JSON.stringify(next);if(bytes!==current){await this.atomic(this.file+'.bak',current);await this.atomic(this.file,bytes)}this.data=next;return result});this.chain=task.catch(()=>{});return task}
 async saveImage(item,bytes){await this.atomic(path.join(this.dir,'images',item.id),bytes);await this.change(d=>{const i=d.gallery.findIndex(x=>x.id===item.id);if(i<0)d.gallery.unshift(item);else d.gallery[i]=item});return item}
 async deleteImage(id){await this.change(d=>{d.gallery=d.gallery.filter(x=>x.id!==id)});await fs.rm(path.join(this.dir,'images',id),{force:true})}
}
