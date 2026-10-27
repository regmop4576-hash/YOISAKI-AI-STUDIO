import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {AppError,fail} from './errors.mjs';
import {CLIENT_ID_RE,CLIENT_SECRET_RE} from './secrets.mjs';
import {httpsJson} from './https-json.mjs';
// v1.7.3 browser authorization for Google Drive, replacing `rclone authorize` in Termux.
// OAuth 2.0 Authorization Code + PKCE (S256) with the loopback redirect http://127.0.0.1:<port>/ of a Google
// OAuth client of type "Desktop app" (Google supports loopback redirects for that client type; they are not
// accepted for Web/Android/iOS client types). Two client sources, never mixed up:
//  - "own":    the user's own client, entered once on the Models page (secrets.json 0600);
//  - "public": a client the MAINTAINER of a public distribution provisions (env YOISAKI_GOOGLE_CLIENT_ID /
//              YOISAKI_GOOGLE_CLIENT_SECRET or config/google-oauth-client.json, both excluded from Git). For
//              installed apps Google treats this "secret" as non-confidential; it identifies the app, it gives
//              no access to anybody's Drive. Every user still signs in with their OWN Google account.
// Scope: drive.readonly only (see GOOGLE_DRIVE_SETUP: why drive.file cannot serve existing nested folders).
// v1.7.3 Easy Connect: the refresh token is kept by the local server (secrets.json 0600, never the browser) so the
// account and the model folder can be set up while no GPU is connected; it is handed to the user's own GPU server
// only when the sync runs there.
export const SCOPE='https://www.googleapis.com/auth/drive.readonly';
const AUTH='https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_HOST='oauth2.googleapis.com';
const PENDING_TTL=10*60*1000;
export function validateClient(b){
 const client_id=typeof b?.client_id==='string'?b.client_id.trim():'',client_secret=typeof b?.client_secret==='string'?b.client_secret.trim():'';
 if(!CLIENT_ID_RE.test(client_id)||!CLIENT_SECRET_RE.test(client_secret))fail('DRIVE_INVALID_CLIENT','Нужны Client ID вида 123…-abc….apps.googleusercontent.com и Client Secret OAuth-клиента Google типа «Приложение для ПК».');
 return {client_id,client_secret};
}
// Maintainer-provisioned public client of a distribution. Invalid values are ignored (reported), never half-used.
export async function loadPublicClient({appRoot,env=process.env}={}){
 let raw=null,source='';
 if(env.YOISAKI_GOOGLE_CLIENT_ID||env.YOISAKI_GOOGLE_CLIENT_SECRET){raw={client_id:env.YOISAKI_GOOGLE_CLIENT_ID,client_secret:env.YOISAKI_GOOGLE_CLIENT_SECRET};source='env'}
 else if(appRoot){try{raw=JSON.parse(await fs.readFile(path.join(appRoot,'config/google-oauth-client.json'),'utf8'));source='file'}catch(e){if(e.code!=='ENOENT')return {client:null,error:'config/google-oauth-client.json не читается или не JSON.'}}}
 if(!raw)return {client:null,error:''};
 try{return {client:{...validateClient(raw),source},error:''}}catch{return {client:null,error:(source==='env'?'YOISAKI_GOOGLE_CLIENT_ID/SECRET':'config/google-oauth-client.json')+': неверный формат Client ID / Secret.'}}
}
// Google requires the exact same redirect URI at authorization and token exchange; loopback clients may use any port.
export const redirectUri=port=>`http://127.0.0.1:${port}/`;
export class OAuthFlows{
 constructor(){this.pending=new Map()}
 start(client,port,context){
  this.prune();
  const state=randomBytes(32).toString('hex'),verifier=randomBytes(48).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  this.pending.set(state,{verifier,redirect:redirectUri(port),created:Date.now(),context,client_id:client.client_id});
  const q=new URLSearchParams({client_id:client.client_id,redirect_uri:redirectUri(port),response_type:'code',scope:SCOPE,access_type:'offline',prompt:'consent select_account',include_granted_scopes:'false',state,code_challenge:challenge,code_challenge_method:'S256'});
  return AUTH+'?'+q;
 }
 // Single use: a replayed or unknown state is rejected.
 take(state){this.prune();if(typeof state!=='string'||!/^[a-f0-9]{64}$/.test(state))return null;const p=this.pending.get(state);this.pending.delete(state);return p||null}
 has(state){return typeof state==='string'&&this.pending.has(state)}
 prune(){const now=Date.now();for(const [k,v] of this.pending)if(now-v.created>PENDING_TTL)this.pending.delete(k)}
}
// Form POST to oauth2.googleapis.com (fixed host). Returns {status, json}; credentials travel in the body only.
export async function postForm(form,{route='/token',request=httpsJson,timeout=20000}={}){
 const body=new URLSearchParams(form).toString();
 const r=await request({host:TOKEN_HOST,path:route,method:'POST',prefix:'GOOGLE',timeout,headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
 return {status:r.status,json:r.json};
}
const reasonOf=(status,json)=>typeof json?.error==='string'?json.error.replace(/[^a-z_]/gi,'').slice(0,60):'HTTP_'+status;
// Exchanges the authorization code for the token object rclone stores ({access_token, token_type, refresh_token, expiry}).
export async function exchangeCode(client,code,pending,{post=postForm,now=Date.now()}={}){
 if(typeof code!=='string'||!code||code.length>2048)fail('DRIVE_OAUTH_FAILED','Google не вернул код авторизации.');
 const {status,json}=await post({code,client_id:client.client_id,client_secret:client.client_secret,redirect_uri:pending.redirect,grant_type:'authorization_code',code_verifier:pending.verifier});
 if(status!==200||!json?.access_token){
  const reason=reasonOf(status,json);
  fail('DRIVE_OAUTH_FAILED',reason==='invalid_client'?'Google отклонил Client ID / Client Secret. Проверьте данные OAuth-клиента.':reason==='invalid_grant'?'Код авторизации устарел или уже использован. Нажмите «Войти через Google» ещё раз.':reason==='redirect_uri_mismatch'?'Тип OAuth-клиента должен быть «Приложение для ПК» (Desktop app).':`Google отклонил обмен кода (${reason}).`);
 }
 if(!json.refresh_token)fail('DRIVE_OAUTH_FAILED','Google не выдал refresh token. Отзовите доступ приложения в аккаунте Google и подключите снова.');
 if(typeof json.scope==='string'&&!json.scope.split(' ').includes(SCOPE))fail('DRIVE_SCOPE_DENIED','Доступ к Google Drive (только чтение) не был разрешён на экране Google: отметьте разрешение и войдите снова.');
 const expires=Number.isFinite(json.expires_in)?json.expires_in:3600;
 return {access_token:String(json.access_token),token_type:'Bearer',refresh_token:String(json.refresh_token),expiry:new Date(now+expires*1000).toISOString()};
}
// New access token from the stored refresh token. invalid_grant = revoked, expired (Testing apps: 7 days) or
// password change → the user has to sign in again (DRIVE_REAUTH_REQUIRED), nothing else is retried.
export async function refreshAccess(client,refreshToken,{post=postForm,now=Date.now()}={}){
 const {status,json}=await post({client_id:client.client_id,client_secret:client.client_secret,refresh_token:refreshToken,grant_type:'refresh_token'});
 if(status===200&&typeof json?.access_token==='string'){const expires=Number.isFinite(json.expires_in)?json.expires_in:3600;return {access_token:json.access_token,expires_at:now+expires*1000,expiry:new Date(now+expires*1000).toISOString()}}
 const reason=reasonOf(status,json);
 if(reason==='invalid_grant')throw new AppError('DRIVE_REAUTH_REQUIRED','Доступ к Google Drive истёк или отозван (у приложений в режиме Testing — через 7 дней). Нажмите «Войти через Google» ещё раз.',409);
 if(reason==='invalid_client'||reason==='unauthorized_client')throw new AppError('DRIVE_REAUTH_REQUIRED','Google не принимает OAuth-клиент, которым выдан доступ (клиент удалён или изменён). Войдите через Google заново.',409);
 throw new AppError('DRIVE_OAUTH_FAILED',`Google не обновил доступ (${reason}). Повторите позже.`,502);
}
// Best effort: revokes the grant at Google (token in the POST body, never in a URL).
export async function revokeToken(token,{post=postForm}={}){
 try{const {status}=await post({token},{route:'/revoke'});return status===200||status===400}catch{return false}
}
