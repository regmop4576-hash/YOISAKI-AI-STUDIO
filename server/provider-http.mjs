import {AppError} from './errors.mjs';

// Fixed provider URLs only at call sites. No redirects: never forward credentials to another host.
export async function providerHttp(url, {method='GET', headers={}, body, maxBytes=4*1024*1024}={}) {
 const timer=AbortSignal.timeout(25000);
 try {
  const res=await fetch(url,{method,headers,body,redirect:'error',signal:timer});
  const reader=res.body?.getReader();let size=0;const chunks=[];
  if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes){await reader.cancel();throw new AppError('PROVIDER_RESPONSE_TOO_LARGE','Ответ провайдера превышает допустимый размер.',502)}chunks.push(Buffer.from(value))}
  let json=null;const raw=Buffer.concat(chunks).toString();
  if(raw)try{json=JSON.parse(raw)}catch{throw new AppError('PROVIDER_INVALID_RESPONSE',`Провайдер вернул не JSON (HTTP ${res.status}).`,502)}
  return {status:res.status,json};
 }catch(e){if(e instanceof AppError)throw e;throw new AppError('PROVIDER_NETWORK','Нет связи с провайдером: проверьте сеть. Запрос изменения не повторялся автоматически.',502)}
}
