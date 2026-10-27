import {fail} from './errors.mjs';
// v1.7.2 Google Drive Auto Sync (CloudCompute only). The website sends actions, never paths/remotes/commands;
// the engine side decides the source folder and the target catalogue. Only whitelisted fields reach the page.
export const SYNC_ACTIONS={status:['GET','/sync/status'],check:['POST','/sync/check'],sync:['POST','/sync/start'],cancel:['POST','/sync/cancel'],connect:['POST','/sync/drive/connect'],disconnect:['POST','/sync/drive/disconnect']};
export const SYNC_ROUTES=Object.values(SYNC_ACTIONS).map(([method,route])=>method+' '+route);
const JOB_STATES=['RUNNING','COMPLETED','FAILED','CANCELLED','INTERRUPTED'];
const ITEM_STATES=['PENDING','INSTALLED','MISSING','CHANGED','CONFLICT','REJECTED','DOWNLOADING','VERIFYING','FAILED'];
const KINDS=['checkpoint','lora','vae'];
const bad=()=>fail('INVALID_RESPONSE','Некорректный ответ синхронизации Google Drive от GPU-сервера.',502);
const clean=s=>s.replace(/[a-f0-9]{64}/g,'[СКРЫТО]').replace(/ya29\.[\w.-]+|1\/\/[\w.-]{20,}|GOCSPX-[\w-]+/g,'[СКРЫТО]');
const str=(v,max,fallback='')=>v===undefined||v===null?fallback:typeof v==='string'&&v.length<=max?clean(v):bad();
const num=v=>v===undefined||v===null?null:Number.isFinite(v)&&v>=0?v:bad();
const bool=v=>v===undefined?false:typeof v==='boolean'?v:bad();
const oneOf=(v,list)=>list.includes(v)?v:bad();
function job(x){
 if(x===null||x===undefined)return null;if(typeof x!=='object')bad();
 const o=x.overall&&typeof x.overall==='object'?x.overall:{};const c=x.current;
 return {id:str(x.id,40),type:oneOf(x.type,['check','sync']),state:oneOf(x.state,JOB_STATES),phase:str(x.phase,40),started_unix:num(x.started_unix),finished_unix:num(x.finished_unix),error:str(x.error,600),error_code:str(x.error_code,40),cancel_requested:bool(x.cancel_requested),restart_recommended:bool(x.restart_recommended),
  overall:Object.fromEntries(['files_total','files_done','files_failed','bytes_total','bytes_done'].map(k=>[k,num(o[k])??0])),
  summary:Object.fromEntries(Object.entries(x.summary&&typeof x.summary==='object'?x.summary:{}).slice(0,20).map(([k,v])=>[str(k,40),num(v)??0])),
  current:c===null||c===undefined?null:typeof c!=='object'?bad():{path:str(c.path,400),kind:oneOf(c.kind,KINDS),phase:str(c.phase,40),bytes_done:num(c.bytes_done),bytes_total:num(c.bytes_total),speed_bps:num(c.speed_bps),resumed_from:num(c.resumed_from)}};
}
export function validateSyncStatus(x){
 if(!x||x.service!=='YOISAKI_DRIVE_SYNC'||!Array.isArray(x.items)||x.items.length>3000)bad();
 const d=x.disk;const n=x.connection&&typeof x.connection==='object'?x.connection:{};
 return {enabled:bool(x.enabled),rclone_available:bool(x.rclone_available),configured:bool(x.configured),source:str(x.source,300),scope:str(x.scope,40),
  connection:{state:oneOf(n.state??'UNKNOWN',['UNKNOWN','OK','ERROR']),error:str(n.error,600),code:str(n.code,40)},
  job:job(x.job),disk:d===null||d===undefined?null:typeof d!=='object'?bad():{free_bytes:num(d.free_bytes),total_bytes:num(d.total_bytes),reserve_bytes:num(d.reserve_bytes)},
  last_success_unix:num(x.last_success_unix),last_check_unix:num(x.last_check_unix),inventory_revision:Number.isInteger(x.inventory_revision)&&x.inventory_revision>=0?x.inventory_revision:bad(),
  verification:str(x.verification,600),owner:oneOf(x.owner??'self',['self','other']),selective:bool(x.selective),
  // 1.7.3: the server accepts the model folder chosen on the website (folder_id in /sync/drive/connect).
  folder_select:bool(x.folder_select),source_kind:oneOf(x.source_kind??'path',['path','folder']),
  items:x.items.map(i=>!i||typeof i!=='object'?bad():{path:str(i.path,400),name:str(i.name,300),kind:oneOf(i.kind,KINDS),size:num(i.size),state:oneOf(i.state,ITEM_STATES),reason:str(i.reason,600),verification:str(i.verification,60)})};
}
// v1.7.3: optional selection for /sync/start ({paths:[...]} = Drive paths reported by /sync/check). Servers before
// 1.7.3 ignore the body and sync everything, so the page offers a selection only when status.selective is true.
export function validateSyncStart(raw){
 const text=Buffer.isBuffer(raw)?raw.toString('utf8').trim():String(raw??'').trim();if(!text)return '{}';
 let b;try{b=JSON.parse(text)}catch{fail('INVALID_JSON','Неверный JSON запроса.')}
 if(b===null||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>k!=='paths'))fail('DRIVE_INVALID_SELECTION','Неверный выбор файлов.');
 if(b.paths===undefined)return '{}';
 if(!Array.isArray(b.paths)||!b.paths.length||b.paths.length>2000||b.paths.some(x=>typeof x!=='string'||!x||x.length>400||/[\u0000-\u001f]/.test(x)))fail('DRIVE_INVALID_SELECTION','Выберите от 1 до 2000 файлов из списка проверки.');
 return JSON.stringify({paths:[...new Set(b.paths)]});
}
// Token JSON for rclone on the GPU: from the browser sign-in (local server) or pasted from `rclone authorize`.
// 1.7.3: optional folder_id/folder_label (model folder chosen on the website); sent only to servers with folder_select.
export function validateConnect(b){
 const token=typeof b?.token==='string'?b.token.trim():'';const client_id=typeof b?.client_id==='string'?b.client_id.trim():'';const client_secret=typeof b?.client_secret==='string'?b.client_secret.trim():'';
 if(token.length<20||token.length>12000||!token.startsWith('{')||client_id.length>200||client_secret.length>200||Object.keys(b).some(k=>!['token','client_id','client_secret','folder_id','folder_label'].includes(k)))fail('DRIVE_INVALID_TOKEN','Вставьте JSON-токен из rclone authorize целиком: {"access_token":…}.');
 const out={token,client_id,client_secret};
 if(b.folder_id!==undefined){if(typeof b.folder_id!=='string'||!/^[A-Za-z0-9_-]{10,200}$/.test(b.folder_id)||typeof b.folder_label!=='string'||b.folder_label.length>300)fail('DRIVE_INVALID_FOLDER','Неверная папка Google Drive.');out.folder_id=b.folder_id;out.folder_label=b.folder_label.replace(/[\u0000-\u001f\u007f]/g,' ')}
 return JSON.stringify(out);
}
