import {AppError,fail} from './errors.mjs';
import {httpsJson,scrub} from './https-json.mjs';
// v1.7.3 Google Drive Easy Connect, phone side (read-only Drive API v3 on the fixed host www.googleapis.com).
// Used only for what must work WITHOUT a GPU: the connected account, browsing folders to choose the model
// folder and a preview of the models in it. Downloads still run on the GPU server (rclone, unchanged checks).
const HOST='www.googleapis.com';
export const FOLDER_MIME='application/vnd.google-apps.folder';
export const FOLDER_ID_RE=/^[A-Za-z0-9_-]{10,200}$/;
// Same folder names and depth as cloudcompute/drive_sync.py (kind folder + up to two subfolders + file).
export const KIND_FOLDERS={checkpoints:'checkpoint',loras:'lora',vae:'vae',controlnet:'controlnet'};
const MAX_DEPTH=4,MAX_FILES=2000,MAX_REQUESTS=60;
const PICKLE=/\.(ckpt|pt|pth|bin|pkl|pickle)$/i;
const name=v=>scrub(typeof v==='string'?v:'',200);
export function validFolderId(id,{allowRoot=false}={}){
 if(allowRoot&&(id==='root'||id==='shared'))return id;
 if(typeof id!=='string'||!FOLDER_ID_RE.test(id))fail('DRIVE_INVALID_FOLDER','Неверный идентификатор папки Google Drive.');
 return id;
}
export async function driveGet(access,route,params,{request=httpsJson}={}){
 const r=await request({host:HOST,path:'/drive/v3/'+route+'?'+new URLSearchParams(params),method:'GET',prefix:'GOOGLE',timeout:20000,max:4*1024*1024,headers:{Authorization:'Bearer '+access}});
 if(r.status===200&&r.json&&typeof r.json==='object')return r.json;
 const reason=String(r.json?.error?.errors?.[0]?.reason||r.json?.error?.status||'');
 if(r.status===401)throw new AppError('DRIVE_TOKEN_EXPIRED','Доступ Google устарел.',401);
 if(r.status===403&&/accessNotConfigured|SERVICE_DISABLED/i.test(reason+r.text))throw new AppError('DRIVE_API_DISABLED','В проекте Google Cloud этого OAuth-клиента не включён Google Drive API: APIs & Services → Library → Google Drive API → Enable.',409);
 if(r.status===403&&/rateLimit|userRateLimit/i.test(reason))throw new AppError('DRIVE_RATE_LIMITED','Google Drive временно ограничил запросы. Повторите через минуту.',429);
 if(r.status===403)throw new AppError('DRIVE_PERMISSION','Google Drive отказал в доступе: разрешение «просмотр файлов Google Drive» не выдано или папка недоступна этому аккаунту. Войдите через Google снова и отметьте разрешение.',403);
 if(r.status===404)throw new AppError('DRIVE_FOLDER_NOT_FOUND','Папка не найдена в Google Drive: она удалена, перемещена в корзину или доступ к ней закрыт.',404);
 throw new AppError('DRIVE_UNAVAILABLE',`Google Drive API ответил HTTP ${r.status}.`,502);
}
export async function account(access,opts){
 const x=await driveGet(access,'about',{fields:'user(displayName,emailAddress)'},opts);
 return {email:name(x.user?.emailAddress).slice(0,120),name:name(x.user?.displayName).slice(0,120)};
}
async function children(access,parent,{foldersOnly=false,pageLimit=5,...opts}={}){
 const q=(parent==='shared'?'sharedWithMe':`'${parent}' in parents`)+(foldersOnly?` and mimeType='${FOLDER_MIME}'`:'')+' and trashed=false';
 const out=[];let pageToken='',pages=0,truncated=false;
 do{
  const x=await driveGet(access,'files',{q,fields:'nextPageToken,files(id,name,mimeType,size)',pageSize:foldersOnly?'200':'1000',orderBy:'folder,name',includeItemsFromAllDrives:'false',spaces:'drive',...(pageToken?{pageToken}:{})},opts);
  for(const f of Array.isArray(x.files)?x.files:[])if(f&&FOLDER_ID_RE.test(f.id))out.push({id:f.id,name:name(f.name),folder:f.mimeType===FOLDER_MIME,size:/^\d{1,15}$/.test(String(f.size??''))?Number(f.size):null});
  pageToken=typeof x.nextPageToken==='string'?x.nextPageToken:'';pages++;
  if(pageToken&&pages>=pageLimit){truncated=true;break}
 }while(pageToken);
 return {items:out,truncated};
}
export async function listFolders(access,parent,opts){
 const p=validFolderId(parent,{allowRoot:true});const {items,truncated}=await children(access,p,{foldersOnly:true,pageLimit:1,...opts});
 return {parent:p,folders:items.filter(x=>x.folder).map(({id,name})=>({id,name})),truncated};
}
// Display path of a folder ("YOISAKI_AI_STUDIO/models" below My Drive), walked up through the parents (max 8 levels).
export async function folderInfo(access,id,opts){
 const fid=validFolderId(id);let cur=await driveGet(access,'files/'+fid,{fields:'id,name,mimeType,parents',supportsAllDrives:'false'},opts);
 if(cur.mimeType!==FOLDER_MIME)fail('DRIVE_NOT_A_FOLDER','Выбранный элемент Google Drive — не папка.');
 const parts=[name(cur.name)],folder={id:fid,name:name(cur.name)};let mine=false;
 for(let i=0;i<8&&Array.isArray(cur.parents)&&cur.parents[0];i++){
  try{cur=await driveGet(access,'files/'+validFolderId(cur.parents[0]),{fields:'id,name,parents'},opts)}catch{break}
  if(!Array.isArray(cur.parents)||!cur.parents.length){mine=true;break}  // reached "My Drive"
  parts.unshift(name(cur.name));
 }
 // root: "my" = the path starts at My Drive; "other" = shared folder whose upper parents are not visible.
 return {...folder,path:parts.join('/').slice(0,400),root:mine?'my':'other'};
}
// Read-only preview of what the GPU sync would find (same folders, depth and formats); sizes come from Drive.
export async function previewFolder(access,id,opts){
 const fid=validFolderId(id);let requests=0,files=0,truncated=false;
 const kinds=Object.fromEntries(Object.values(KIND_FOLDERS).map(k=>[k,{files:0,bytes:0,rejected:0}]));
 const step=async parent=>{if(++requests>MAX_REQUESTS){truncated=true;return {items:[],truncated:true}}const r=await children(access,parent,opts);if(r.truncated)truncated=true;return r};
 const top=(await step(fid)).items;const found=[];
 const walk=async(folderId,kind,depth)=>{
  for(const f of (await step(folderId)).items){
   if(truncated&&requests>MAX_REQUESTS)return;
   if(f.folder){if(depth+1<MAX_DEPTH&&!f.name.startsWith('.'))await walk(f.id,kind,depth+1);continue}
   if(++files>MAX_FILES){truncated=true;return}
   if(/\.safetensors$/i.test(f.name)){kinds[kind].files++;kinds[kind].bytes+=f.size||0}else if(PICKLE.test(f.name))kinds[kind].rejected++;
  }
 };
 for(const f of top)if(f.folder&&KIND_FOLDERS[f.name]){found.push(f.name);await walk(f.id,KIND_FOLDERS[f.name],1)}
 return {folder_id:fid,kinds,kind_folders:found,missing_folders:Object.keys(KIND_FOLDERS).filter(k=>!found.includes(k)),loose_files:top.filter(f=>!f.folder&&/\.safetensors$/i.test(f.name)).length,truncated,checked_at:Date.now()};
}
