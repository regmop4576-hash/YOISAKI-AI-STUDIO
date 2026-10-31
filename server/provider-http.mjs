import {AppError} from './errors.mjs';

// Fixed provider URLs only at call sites. No redirects: never forward credentials to another host.
// v1.7.7: Retry-After (seconds or HTTP date) is returned for rate-limit handling; `timeout` is configurable per call
// (a paid creation waits longer, so fewer answers are lost). A lost answer is never treated as "not created".
export function retryAfterSeconds(value,now=Date.now()){
 if(typeof value!=='string'||!value.trim())return null;
 if(/^\s*\d{1,6}\s*$/.test(value))return Number(value);
 const at=Date.parse(value);return Number.isFinite(at)?Math.max(0,Math.ceil((at-now)/1000)):null;
}
export async function providerHttp(url, {method='GET', headers={}, body, maxBytes=4*1024*1024, timeout=25000}={}) {
 const timer=AbortSignal.timeout(timeout);
 try {
  const res=await fetch(url,{method,headers,body,redirect:'error',signal:timer});
  const reader=res.body?.getReader();let size=0;const chunks=[];
  if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes){await reader.cancel();throw new AppError('PROVIDER_RESPONSE_TOO_LARGE','Ответ провайдера превышает допустимый размер.',502)}chunks.push(Buffer.from(value))}
  let json=null;const raw=Buffer.concat(chunks).toString();
  const retryAfter=retryAfterSeconds(res.headers.get('retry-after'));
  if(raw)try{json=JSON.parse(raw)}catch{const e=new AppError('PROVIDER_INVALID_RESPONSE',`Провайдер вернул не JSON (HTTP ${res.status}).`,502);e.http_status=res.status;e.retry_after=retryAfter;throw e}
  return {status:res.status,json,retryAfter};
 }catch(e){if(e instanceof AppError)throw e;const out=new AppError('PROVIDER_NETWORK',e?.name==='TimeoutError'||e?.name==='AbortError'?'Провайдер не ответил вовремя. Результат запроса неизвестен; повтор не выполнялся.':'Нет связи с провайдером: проверьте сеть. Запрос изменения не повторялся автоматически.',502);out.timeout=e?.name==='TimeoutError'||e?.name==='AbortError';throw out}
}

// v1.7.6: binary prefix read (Google Drive Range requests for safetensors headers). Reads at most maxBytes and then
// stops the transfer, so a server that ignores Range never makes the phone download a whole model. Redirects are
// followed only to Google download hosts, at most twice, and the Authorization header never leaves googleapis.com.
const MEDIA_HOSTS=/^(?:www\.googleapis\.com|[a-z0-9-]+\.googleusercontent\.com)$/;
export async function providerBytes(url,{headers={},maxBytes=65536,timeout=25000}={}){
 let target=url,auth=headers;
 try{
  for(let hop=0;hop<3;hop++){
   const res=await fetch(target,{headers:auth,redirect:'manual',signal:AbortSignal.timeout(timeout)});
   if(res.status>=300&&res.status<400){
    const next=new URL(res.headers.get('location')||'',target);await res.body?.cancel();
    if(next.protocol!=='https:'||!MEDIA_HOSTS.test(next.hostname))throw new AppError('PROVIDER_REDIRECT','Google перенаправил запрос на неожиданный адрес.',502);
    if(next.hostname!=='www.googleapis.com'){auth={...auth};delete auth.Authorization}
    target=next.href;continue;
   }
   const reader=res.body?.getReader();const chunks=[];let size=0,truncated=false;
   if(reader)for(;;){const {done,value}=await reader.read();if(done)break;chunks.push(Buffer.from(value));size+=value.length;if(size>=maxBytes){truncated=true;await reader.cancel().catch(()=>{});break}}
   const bytes=Buffer.concat(chunks).subarray(0,maxBytes);let json=null;
   if(res.status>=400)try{json=JSON.parse(bytes.toString())}catch{}
   return {status:res.status,bytes,truncated,json};
  }
  throw new AppError('PROVIDER_REDIRECT','Слишком много перенаправлений Google.',502);
 }catch(e){if(e instanceof AppError)throw e;throw new AppError('PROVIDER_NETWORK','Нет связи с провайдером: проверьте сеть. Запрос изменения не повторялся автоматически.',502)}
}
