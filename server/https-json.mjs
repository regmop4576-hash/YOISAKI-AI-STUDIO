import https from 'node:https';
import dns from 'node:dns/promises';
import {AppError} from './errors.mjs';
import {publicIP} from './upstream.mjs';
// v1.7.3 HTTPS JSON client for the FIXED provider hosts of the local app (CloudCompute API, Google OAuth / Drive).
// The host is never taken from a request: callers pass a constant. DNS is resolved once, every address must be
// public (no DNS rebinding into the LAN) and the connection is pinned to it; TLS is verified with the hostname,
// redirects are not followed and the answer is size-limited. Headers (Authorization!) are never logged or echoed.
const LABELS={CC:'CloudCompute API',GOOGLE:'Google'};
export async function httpsJson({host,path,method='GET',headers={},body,timeout=20000,max=2*1024*1024,prefix='CC',lookup=dns.lookup,transport=https.request}){
 const who=LABELS[prefix]||host;
 let addresses,timer;
 try{addresses=await Promise.race([lookup(host,{all:true,verbatim:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new AppError(prefix+'_NETWORK',`${who}: DNS не ответил. Проверьте интернет на телефоне.`,504)),10000)})])}
 catch(e){if(e instanceof AppError)throw e;throw new AppError(prefix+'_NETWORK',`${who}: адрес ${host} не найден. Проверьте интернет на телефоне.`,502)}
 finally{clearTimeout(timer)}
 if(!addresses?.length||addresses.some(x=>!publicIP(x.address)))throw new AppError(prefix+'_PRIVATE_DESTINATION',`${who}: имя ${host} указывает на частный адрес. Запрос заблокирован.`,403);
 const pinned=addresses.find(x=>x.family===4)||addresses[0];
 return new Promise((resolve,reject)=>{
  let done=false;const finish=(err,value)=>{if(done)return;done=true;clearTimeout(deadline);err?reject(err):resolve(value)};
  const req=transport({hostname:host,port:443,path,method,servername:host,agent:false,lookup:(_h,options,cb)=>options.all?cb(null,[pinned]):cb(null,pinned.address,pinned.family),
   headers:{Accept:'application/json','User-Agent':'YOISAKI-AI-STUDIO-local',...headers,...(body!==undefined?{'Content-Length':Buffer.byteLength(body)}:{})}},res=>{
   const chunks=[];let size=0;
   res.on('data',c=>{size+=c.length;if(size>max){finish(new AppError(prefix+'_INVALID_RESPONSE',`${who}: ответ слишком большой.`,502));res.destroy()}else chunks.push(c)});
   res.on('error',()=>finish(new AppError(prefix+'_NETWORK',`${who}: соединение прервалось.`,502)));
   res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');let json=null;try{json=text?JSON.parse(text):null}catch{}finish(null,{status:res.statusCode||502,json,text:text.slice(0,2000),location:res.headers.location?'redirect':''})});
  });
  const deadline=setTimeout(()=>{finish(new AppError(prefix+'_TIMEOUT',`${who} не ответил за ${Math.round(timeout/1000)} с.`,504));req.destroy()},timeout);
  req.on('error',e=>{const tls=/CERT|SSL|EPROTO|TLS/i.test(String(e.code||''));finish(new AppError(tls?prefix+'_TLS':prefix+'_NETWORK',tls?`${who}: сертификат HTTPS не прошёл проверку. Соединение не установлено.`:`${who}: нет связи (${host}).`,502))});
  req.end(body);
 });
}
// Removes anything that could be a credential from provider-supplied text before it reaches the page or the log.
export function scrub(text,max=300){
 return String(text??'').replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi,'Bearer [СКРЫТО]').replace(/cc-[A-Za-z0-9._~+\/=-]{4,}/g,'cc-[СКРЫТО]')
  .replace(/ya29\.[\w.-]+|1\/\/[\w.-]{10,}|GOCSPX-[\w-]+/g,'[СКРЫТО]').replace(/[a-f0-9]{64}/g,'[СКРЫТО]').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
}
