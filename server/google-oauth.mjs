import https from 'node:https';
import {createHash,randomBytes} from 'node:crypto';
import {AppError,fail} from './errors.mjs';
import {CLIENT_ID_RE,CLIENT_SECRET_RE} from './secrets.mjs';
// Installed CLI OAuth client, PKCE and loopback callback. A publisher may distribute a
// registered public Desktop client; account tokens always belong to each local installation.
export const SCOPE='https://www.googleapis.com/auth/drive.readonly';
const AUTH='https://accounts.google.com/o/oauth2/v2/auth';
const PENDING_TTL=10*60*1000;
export function validateClient(b){
 const client_id=typeof b?.client_id==='string'?b.client_id.trim():'',client_secret=typeof b?.client_secret==='string'?b.client_secret.trim():'';
 if(!CLIENT_ID_RE.test(client_id)||!CLIENT_SECRET_RE.test(client_secret))fail('DRIVE_INVALID_CLIENT','Нужны Client ID вида 123…-abc….apps.googleusercontent.com и Client Secret OAuth-клиента Google типа «Приложение для ПК».');
 return {client_id,client_secret};
}
// Google requires the exact same redirect URI at authorization and token exchange; loopback clients may use any port.
export const redirectUri=port=>`http://127.0.0.1:${port}/`;
export class OAuthFlows{
 constructor(){this.pending=new Map()}
 start(client,port,context){
  this.prune();
  const state=randomBytes(32).toString('hex'),verifier=randomBytes(48).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  this.pending.set(state,{verifier,redirect:redirectUri(port),created:Date.now(),context});
  const q=new URLSearchParams({client_id:client.client_id,redirect_uri:redirectUri(port),response_type:'code',scope:SCOPE,access_type:'offline',prompt:'consent select_account',include_granted_scopes:'false',state,code_challenge:challenge,code_challenge_method:'S256'});
  return AUTH+'?'+q;
 }
 // Single use: a replayed or unknown state is rejected.
 take(state){this.prune();if(typeof state!=='string'||!/^[a-f0-9]{64}$/.test(state))return null;const p=this.pending.get(state);this.pending.delete(state);return p||null}
 has(state){return typeof state==='string'&&this.pending.has(state)}
 prune(){const now=Date.now();for(const [k,v] of this.pending)if(now-v.created>PENDING_TTL)this.pending.delete(k)}
}
export function postForm(form,timeout=20000){
 const body=new URLSearchParams(form).toString();
 return new Promise((resolve,reject)=>{
  const req=https.request({hostname:'oauth2.googleapis.com',port:443,path:'/token',method:'POST',agent:false,headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body),Accept:'application/json'}},res=>{
   const chunks=[];let size=0;
   res.on('data',c=>{size+=c.length;if(size<65536)chunks.push(c)});
   res.on('end',()=>{let json=null;try{json=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{}resolve({status:res.statusCode,json})});
  });
  req.setTimeout(timeout,()=>req.destroy(new AppError('DRIVE_OAUTH_FAILED','Google не ответил при обмене кода авторизации.',504)));
  req.on('error',e=>reject(e instanceof AppError?e:new AppError('DRIVE_OAUTH_FAILED','Нет связи с Google (oauth2.googleapis.com).',502)));
  req.end(body);
 });
}
// Exchanges the authorization code for the token object rclone stores ({access_token, token_type, refresh_token, expiry}).
export async function exchangeCode(client,code,pending,{post=postForm,now=Date.now()}={}){
 if(typeof code!=='string'||!code||code.length>2048)fail('DRIVE_OAUTH_FAILED','Google не вернул код авторизации.');
 const {status,json}=await post({code,client_id:client.client_id,client_secret:client.client_secret,redirect_uri:pending.redirect,grant_type:'authorization_code',code_verifier:pending.verifier});
 if(status!==200||!json?.access_token){
  const reason=typeof json?.error==='string'?json.error.replace(/[^a-z_]/gi,'').slice(0,60):'HTTP_'+status;
  fail('DRIVE_OAUTH_FAILED',reason==='invalid_client'?'Google отклонил Client ID / Client Secret. Проверьте данные OAuth-клиента.':reason==='invalid_grant'?'Код авторизации устарел или уже использован. Нажмите «Подключить Google Drive» ещё раз.':reason==='redirect_uri_mismatch'?'Тип OAuth-клиента должен быть «Приложение для ПК» (Desktop app).':`Google отклонил обмен кода (${reason}).`);
 }
 if(!json.refresh_token)fail('DRIVE_OAUTH_FAILED','Google не выдал refresh token. Отзовите доступ приложения в аккаунте Google и подключите снова.');
 if(typeof json.scope==='string'&&!json.scope.split(' ').includes(SCOPE))fail('DRIVE_OAUTH_FAILED','Доступ к Google Drive (только чтение) не был разрешён на экране Google.');
 const expires=Number.isFinite(json.expires_in)?json.expires_in:3600;
 return {access_token:String(json.access_token),token_type:'Bearer',refresh_token:String(json.refresh_token),expiry:new Date(now+expires*1000).toISOString()};
}
