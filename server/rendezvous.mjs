import https from 'node:https';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {AppError} from './errors.mjs';
// v1.7.3 optional address discovery for Cloudflare Quick Tunnels (whose URL changes on every GPU start).
// The GPU launcher publishes {url, ts, sig} to an ntfy topic; this app reads it back.
//  - topic = HMAC(engine token, label): unguessable without the token, the token itself is never sent;
//  - sig = HMAC(engine token, url|ts): a forged or altered record is ignored, so a third party can never make
//    this app send the engine token to a foreign host. The found URL still passes the provider host policy.
// Off unless both sides opt in (YOISAKI_RENDEZVOUS=ntfy on the GPU, «Находить новый адрес» on the website).
// Must stay byte-compatible with cloudcompute/rendezvous.py.
export const RENDEZVOUS_HOST=process.env.YOISAKI_RENDEZVOUS_HOST&&/^[a-z0-9.-]{3,253}$/.test(process.env.YOISAKI_RENDEZVOUS_HOST)?process.env.YOISAKI_RENDEZVOUS_HOST:'ntfy.sh';
const MAX_AGE=24*3600,MAX_SKEW=300;
const mac=(token,text)=>createHmac('sha256',Buffer.from(token,'hex')).update(text).digest('hex');
export const topicFor=token=>'yoisaki-'+mac(token,'yoisaki-rendezvous-topic-v1').slice(0,40);
export const sign=(token,url,ts)=>mac(token,`yoisaki-rendezvous-v1\n${url}\n${ts}`);
// ndjson lines of ntfy's poll API -> the newest correctly signed, fresh record (or null).
export function pickLatest(body,token,now=Date.now()/1000){
 let best=null;
 for(const line of String(body).split('\n')){
  let event,record;
  try{event=JSON.parse(line);if(event?.event!=='message'||typeof event.message!=='string')continue;record=JSON.parse(event.message)}catch{continue}
  if(record?.v!==1||typeof record.url!=='string'||record.url.length>300||!Number.isInteger(record.ts)||!/^[a-f0-9]{64}$/.test(record.sig||''))continue;
  if(record.ts<now-MAX_AGE||record.ts>now+MAX_SKEW)continue;
  const expected=Buffer.from(sign(token,record.url,record.ts),'hex');
  if(!timingSafeEqual(expected,Buffer.from(record.sig,'hex')))continue;
  if(!best||record.ts>best.ts)best=record;
 }
 return best;
}
function get(pathname,timeout=10000){
 return new Promise((resolve,reject)=>{
  const req=https.get({hostname:RENDEZVOUS_HOST,port:443,path:pathname,headers:{Accept:'application/x-ndjson'},agent:false},res=>{
   const chunks=[];let size=0;
   res.on('data',c=>{size+=c.length;if(size>262144){req.destroy();reject(new AppError('RENDEZVOUS_ERROR','Слишком большой ответ сервиса обнаружения.',502))}else chunks.push(c)});
   res.on('end',()=>res.statusCode===200?resolve(Buffer.concat(chunks).toString('utf8')):reject(new AppError('RENDEZVOUS_ERROR',`Сервис обнаружения ответил HTTP ${res.statusCode}.`,502)));
  });
  req.setTimeout(timeout,()=>req.destroy(new AppError('RENDEZVOUS_ERROR','Сервис обнаружения адреса не ответил.',504)));
  req.on('error',e=>reject(e instanceof AppError?e:new AppError('RENDEZVOUS_ERROR','Сервис обнаружения адреса недоступен.',502)));
 });
}
// Returns the newest verified URL published for this token, or null.
export async function discover(token,{fetchText=get,now}={}){
 const body=await fetchText('/'+topicFor(token)+'/json?poll=1&since=24h');
 return pickLatest(body,token,now)?.url||null;
}
