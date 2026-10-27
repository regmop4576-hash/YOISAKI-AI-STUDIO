import {AppError,fail} from './errors.mjs';
import {refreshAccess,revokeToken,postForm,SCOPE} from './google-oauth.mjs';
import {account,listFolders,folderInfo,previewFolder} from './google-drive.mjs';
import {httpsJson} from './https-json.mjs';
// v1.7.3 Google Drive Easy Connect: the Drive link of THIS installation (one Google account, one model folder),
// independent of any GPU. Access tokens live in memory only; the refresh token in secrets.json (0600).
export class DriveAccount{
 constructor({secrets,publicClient=null,post=postForm,request=httpsJson,now=()=>Date.now()}){
  this.secrets=secrets;this.publicClient=publicClient;this.post=post;this.request=request;this.now=now;this.access=null;this.preview=null;this.error=null;
 }
 // Which OAuth client signs the user in: their own (if saved) wins over the maintainer's public one.
 client(kind){
  const own=this.secrets.google();
  if(kind==='own')return own?{...own,source:'own'}:null;
  if(kind==='public')return this.publicClient?{...this.publicClient,source:'public'}:null;
  return own?{...own,source:'own'}:this.publicClient?{...this.publicClient,source:'public'}:null;
 }
 linkedClient(){
  const d=this.secrets.drive();if(!d)return null;const c=this.client(d.client);
  return c&&c.client_id===d.client_id?c:null;
 }
 view(){
  const d=this.secrets.driveView();const pub=!!this.publicClient,own=!!this.secrets.google();
  return {...d,scope:SCOPE,client_available:pub||own,public_client:pub,own_client:own,preview:d.linked&&this.preview?.folder_id===d.folder?.id?this.preview:null,error:this.error};
 }
 async link(client,token,{autoSync=true}={}){
  this.access={token:token.access_token,expires_at:Date.parse(token.expiry)||this.now()+3000000};this.preview=null;this.error=null;
  const old=this.secrets.drive();
  // A new sign-in with another account must not keep the old folder (it would belong to someone else).
  let who=null;try{who=await account(this.access.token,{request:this.request})}catch{}
  const sameAccount=old&&who&&old.account?.email&&old.account.email===who.email;
  await this.secrets.setDrive(null);
  await this.secrets.setDrive({refresh_token:token.refresh_token,client:client.source==='own'?'own':'public',client_id:client.client_id,linked_at:this.now(),account:who,folder:sameAccount?old.folder:null,
   auto_provision:old?.auto_provision??true,auto_sync:old?old.auto_sync:autoSync,reauth:false,provisioned:null});
  return this.view();
 }
 // Valid access token (refreshed when needed). DRIVE_REAUTH_REQUIRED marks the link for a new sign-in.
 async token(){
  const d=this.secrets.drive();if(!d)fail('DRIVE_NOT_LINKED','Google Drive не подключён. Нажмите «Войти через Google».',409);
  if(d.reauth)fail('DRIVE_REAUTH_REQUIRED','Доступ к Google Drive истёк или отозван. Нажмите «Войти через Google» ещё раз.',409);
  if(this.access&&this.access.expires_at-this.now()>120000)return this.access.token;
  const c=this.linkedClient();
  if(!c){await this.secrets.setDrive({reauth:true});fail('DRIVE_REAUTH_REQUIRED','OAuth-клиент, которым выдан доступ к Google Drive, больше не настроен. Войдите через Google заново.',409)}
  try{const r=await refreshAccess(c,d.refresh_token,{post:this.post,now:this.now()});this.access={token:r.access_token,expires_at:r.expires_at};return r.access_token}
  catch(e){if(e.code==='DRIVE_REAUTH_REQUIRED'){this.access=null;await this.secrets.setDrive({reauth:true})}throw e}
 }
 // Runs a Drive call; an access token the API rejects (401) is refreshed once.
 async api(fn){
  try{return await fn(await this.token())}
  catch(e){if(e.code!=='DRIVE_TOKEN_EXPIRED')throw e;this.access=null;try{return await fn(await this.token())}catch(x){if(x.code==='DRIVE_TOKEN_EXPIRED')throw new AppError('DRIVE_REAUTH_REQUIRED','Google не принимает доступ. Войдите через Google заново.',409);throw x}}
 }
 async refreshAccount(){const who=await this.api(t=>account(t,{request:this.request}));await this.secrets.setDrive({account:who});return this.view()}
 folders(parent){return this.api(t=>listFolders(t,parent,{request:this.request}))}
 async selectFolder(id){
  const info=await this.api(t=>folderInfo(t,id,{request:this.request}));
  await this.secrets.setDrive({folder:info,provisioned:null});this.preview=null;
  try{await this.check()}catch(e){this.error={code:e.code||'DRIVE_ERROR',message:e.message}}
  return this.view();
 }
 async check(){
  const d=this.secrets.drive();if(!d?.folder)fail('DRIVE_NO_FOLDER','Сначала выберите папку моделей в Google Drive.',409);
  this.error=null;this.preview=await this.api(t=>previewFolder(t,d.folder.id,{request:this.request}));return this.view();
 }
 async settings(b){
  if(!this.secrets.drive())fail('DRIVE_NOT_LINKED','Google Drive не подключён.',409);
  const patch={};for(const k of ['auto_provision','auto_sync'])if(typeof b[k]==='boolean')patch[k]=b[k];
  if(!Object.keys(patch).length)fail('INVALID_REQUEST','Неверный запрос.');
  await this.secrets.setDrive(patch);return this.view();
 }
 // rclone token object for the user's GPU server ({access_token, token_type, refresh_token, expiry}) + its client.
 async gpuCredentials(){
  await this.token();const d=this.secrets.drive();const c=this.linkedClient();
  return {token:JSON.stringify({access_token:this.access.token,token_type:'Bearer',refresh_token:d.refresh_token,expiry:new Date(this.access.expires_at).toISOString()}),client_id:c.client_id,client_secret:c.client_secret,folder:d.folder};
 }
 markProvisioned(origin){const d=this.secrets.drive();return d?this.secrets.setDrive({provisioned:{origin,linked_at:d.linked_at,folder_id:d.folder?.id||''}}):null}
 needsProvision(origin){const d=this.secrets.drive();if(!d||d.reauth||!d.auto_provision)return false;const p=d.provisioned;return !p||p.origin!==origin||p.linked_at!==d.linked_at||p.folder_id!==(d.folder?.id||'')}
 async unlink({revoke=true}={}){
  const d=this.secrets.drive();let revoked=false;
  if(d&&revoke)revoked=await revokeToken(d.refresh_token,{post:this.post});
  this.access=null;this.preview=null;this.error=null;await this.secrets.setDrive(null);return {revoked};
 }
}
