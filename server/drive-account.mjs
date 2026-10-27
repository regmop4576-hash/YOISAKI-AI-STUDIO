import {randomUUID} from 'node:crypto';
import {AppError,fail} from './errors.mjs';
import {providerHttp,providerBytes} from './provider-http.mjs';
import {SCOPE} from './google-oauth.mjs';

const folderId=value=>{if(typeof value!=='string'||! /^[A-Za-z0-9_-]{1,200}$/.test(value))fail('DRIVE_INVALID_FOLDER','Некорректный ID папки Google Drive.');return value};
// Google's machine-readable reason (error.errors[0].reason) separates quota limits from missing permissions.
export function driveFailure(status,json){
 const reason=String(json?.error?.errors?.[0]?.reason||json?.error?.status||'').replace(/[^A-Za-z_]/g,'').slice(0,60);
 const limited=/rate|quota|LimitExceeded/i.test(reason);
 const text=status===401?'войдите в Google заново':status===403?(limited?'Google временно ограничил запросы или скачивание':'доступ запрещён: у этого аккаунта нет прав на файл или папку'):status===404?'папка или файл не найдены (удалены или нет доступа)':status===416?'запрошенный диапазон байтов вне файла':'ошибка запроса';
 const e=new AppError('DRIVE_HTTP_'+status,`Google Drive HTTP ${status}: ${text}.`,status>=400&&status<500?status:502);e.reason=reason;e.limited=limited;throw e;
}
export class DriveAccount {
 constructor(secrets,http=providerHttp,bytes=providerBytes){this.secrets=secrets;this.http=http;this.bytes=bytes;this.refreshing=null}
 view(){const d=this.secrets.drive();return {connected:!!d,account:d?.account||null,folder:d?.folder||null}}
 async call(token,path){
  const r=await this.http('https://www.googleapis.com/drive/v3'+path,{headers:{Authorization:'Bearer '+token.access_token,Accept:'application/json'}});
  if(r.status<200||r.status>=300)driveFailure(r.status,r.json);
  return r.json;
 }
 async accept(client,token){
  const data=await this.call(token,'/about?fields=user(displayName,emailAddress)');
  if(!data?.user?.emailAddress)fail('DRIVE_INVALID_RESPONSE','Google не подтвердил аккаунт.',502);
  return {session_id:randomUUID(),client,token,account:{email:String(data.user.emailAddress),name:String(data.user.displayName||'')},folder:null};
 }
 async token(force=false){
  const d=this.secrets.drive();if(!d)fail('DRIVE_NOT_CONNECTED','Сначала войдите в Google.',409);
  if(!force&&Date.parse(d.token.expiry)>Date.now()+60000)return d.token;
  if(this.refreshing)return this.refreshing;
  this.refreshing=(async()=>{
   const {status,json}=await this.http('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:d.token.refresh_token,...d.client}).toString()});
   if(status!==200||!json?.access_token)fail('DRIVE_REFRESH_FAILED','Не удалось обновить доступ Google. Войдите в Google заново.',401);
   if(json.scope&&!json.scope.split(' ').includes(SCOPE))fail('DRIVE_SCOPE','Google не предоставил доступ к чтению Drive.',403);
   const token={...d.token,access_token:json.access_token,refresh_token:json.refresh_token||d.token.refresh_token,expiry:new Date(Date.now()+(Number(json.expires_in)||3600)*1000).toISOString()};
   await this.secrets.change(next=>{if(next.drive?.session_id!==d.session_id||next.drive?.token.refresh_token!==d.token.refresh_token)fail('DRIVE_CHANGED','Аккаунт изменён. Повторите действие.',409);next.drive.token=token});
   return token;
  })().finally(()=>{this.refreshing=null});return this.refreshing;
 }
 async get(path){try{return await this.call(await this.token(),path)}catch(e){if(e.code!=='DRIVE_HTTP_401')throw e;return this.call(await this.token(true),path)}}
 // v1.7.6: first bytes of a file (safetensors header). Never the whole model: providerBytes stops at maxBytes.
 async media(id,start,end){
  folderId(id);const read=async token=>{const r=await this.bytes(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`,{headers:{Authorization:'Bearer '+token.access_token,Range:`bytes=${start}-${end}`},maxBytes:end+1});if(r.status!==200&&r.status!==206)driveFailure(r.status,r.json);return r.status===200?r.bytes.subarray(start,end+1):r.bytes};
  try{return await read(await this.token())}catch(e){if(e.code!=='DRIVE_HTTP_401')throw e;return read(await this.token(true))}
 }
 async folders(parent='root',page=''){
  folderId(parent);if(typeof page!=='string'||page.length>2048)fail('DRIVE_INVALID_PAGE','Некорректная страница.');
  const query=new URLSearchParams({q:`'${parent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,fields:'nextPageToken,files(id,name)',pageSize:'100',orderBy:'name',supportsAllDrives:'true',includeItemsFromAllDrives:'true'});if(page)query.set('pageToken',page);
  const data=await this.get('/files?'+query);if(!Array.isArray(data?.files))fail('DRIVE_INVALID_RESPONSE','Google вернул неверный список папок.',502);
  return {folders:data.files.map(f=>({id:folderId(f.id),name:String(f.name)})),next_page:data.nextPageToken||null};
 }
 async choose(value){
  const original=this.secrets.drive();const data=await this.get('/files/'+folderId(value)+'?fields=id,name,mimeType,trashed&supportsAllDrives=true');
  if(data.mimeType!=='application/vnd.google-apps.folder'||data.trashed)fail('DRIVE_INVALID_FOLDER','Выбранный объект не является доступной папкой.');
  await this.secrets.change(d=>{if(!original||d.drive?.session_id!==original.session_id)fail('DRIVE_CHANGED','Аккаунт изменён.',409);d.drive.folder={id:folderId(data.id),name:String(data.name)}});return this.view();
 }
 async binding(){const original=this.secrets.drive();const token=await this.token();const d=this.secrets.drive();if(d?.session_id!==original?.session_id)fail('DRIVE_CHANGED','Аккаунт изменён.',409);if(!d?.folder)fail('DRIVE_FOLDER_REQUIRED','Выберите папку моделей.',409);return {token:JSON.stringify(token),...d.client,root_folder_id:d.folder.id}}
}
