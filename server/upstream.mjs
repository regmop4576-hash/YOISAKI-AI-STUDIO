import {validateControl} from './controlnet.mjs';
import {MODES,validateImg2Img} from './img2img.mjs';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import {AppError,fail} from './errors.mjs';
import {validHost,providerName,endpoint} from './providers.mjs';
export function parseTunnel(raw,provider='colab'){
 providerName(provider);
 let u;try{u=new URL(raw.trim())}catch{fail('INVALID_URL','Неверная ссылка. Вставьте полную ссылку из панели движка.')}
 const clean=new URL(u);clean.hash='';endpoint(clean.href,provider);
 const q=new URLSearchParams(u.hash.slice(1));const token=q.get('token');
 if(q.getAll('token').length!==1||[...q.keys()].some(k=>k!=='token')||!token||!/^[a-f0-9]{64}$/.test(token))fail('INVALID_TOKEN','Вставьте ссылку целиком, включая #token=… из панели движка.');
 return {origin:u.origin,hostname:u.hostname,token,provider};
}
export function publicIP(ip){
 if(net.isIP(ip)===4){const [a,b,c]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===88&&c===99)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113)}
 if(net.isIP(ip)===6){const normalized=ip.toLowerCase();return /^[23][0-9a-f]{0,3}:/.test(normalized)&&!(normalized.startsWith('2001:')&&(parseInt(normalized.split(':')[1]||'0',16)<0x200||parseInt(normalized.split(':')[1],16)===0xdb8))&&!normalized.startsWith('2002:')&&!normalized.includes('.')}
 return false;
}
export function allowedRoute(method,route){return method==='GET'&&['/health','/models'].includes(route)||method==='POST'&&(route==='/generate'||route==='/controlnet/preprocess'||/^\/jobs\/[a-f0-9-]{36}\/ack$/.test(route))||['GET','DELETE'].includes(method)&&/^\/jobs\/[a-f0-9-]{36}$/.test(route)||method==='GET'&&/^\/results\/[a-f0-9-]{36}\?index=[0-3]$/.test(route)}
export async function requestUpstream(connection,route,{method='GET',body,timeout=45000,binary=false,lookup=dns.lookup,transport=https.request}={}){
 if(!connection||!validHost(connection.hostname,connection.provider||'colab')||connection.origin!=='https://'+connection.hostname||!allowedRoute(method,route))fail('PROXY_DENIED','Запрос к этому endpoint запрещён.',403);
 let addresses;let timer;
 try{addresses=await Promise.race([lookup(connection.hostname,{all:true,verbatim:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new AppError('DNS_TIMEOUT','DNS туннеля не ответил. Повторите подключение.',504)),10000)})])}catch(e){if(e instanceof AppError)throw e;fail('DNS_ERROR','Адрес туннеля не найден. Получите новую ссылку на GPU-сервере.',502)}finally{clearTimeout(timer)}
 if(!addresses.length||addresses.some(x=>!publicIP(x.address)))fail('PRIVATE_DESTINATION','Туннель указывает на запрещённый адрес.',403);
 const pinned=addresses.find(x=>x.family===4)||addresses[0];
 return new Promise((resolve,reject)=>{
 let done=false;const finish=(err,value)=>{if(done)return;done=true;clearTimeout(deadline);err?reject(err):resolve(value)};
 const req=transport({hostname:connection.hostname,port:443,path:route,method,servername:connection.hostname,agent:false,lookup:(_host,options,cb)=>options.all?cb(null,[pinned]):cb(null,pinned.address,pinned.family),headers:{Authorization:'Bearer '+connection.token,Accept:binary?'image/png':'application/json',...(body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{})}},res=>{
 const chunks=[];let size=0;const max=binary?25*1024*1024:12*1024*1024;
 res.on('data',chunk=>{size+=chunk.length;if(size>max){finish(new AppError('UPSTREAM_TOO_LARGE','Ответ GPU превышает допустимый размер.',502));res.destroy()}else chunks.push(chunk)});
 res.on('error',()=>finish(new AppError('UPSTREAM_INTERRUPTED','Соединение с GPU прервалось. Обновите статус.',502)));
 res.on('end',()=>{const data=Buffer.concat(chunks);const status=res.statusCode||502;
 if(status>=300&&status<400)return finish(new AppError('REDIRECT_REJECTED','Туннель перенаправляет запрос. Скопируйте новую прямую ссылку.',502));
 if(status===401||status===403)return finish(new AppError('AUTH_REJECTED','GPU отклонил токен. Скопируйте свежую полную ссылку из панели движка.',401));
 if(status>=400&&route==='/controlnet/preprocess'){let detail;try{detail=JSON.parse(data.toString()).detail}catch{}if(typeof detail==='string')return finish(new AppError('CONTROL_PREPROCESS_FAILED',detail.replace(/[a-f0-9]{64}/g,'[СКРЫТО]').slice(0,600),status));}
 // AUD-009: keep the engine's own reason for rejected /generate requests (sanitised, no tokens/paths/traces).
 if(route==='/generate'&&[400,422,429,507].includes(status)){const detail=engineDetail(data);if(detail)return finish(new AppError(status===422||status===400?'INVALID_PARAMETERS':'UPSTREAM_HTTP','GPU отклонил задание: '+detail,status===429?409:502))}
 if(status>=400)return finish(new AppError(status===404?'JOB_NOT_FOUND':status===409?'GPU_BUSY':status===422?'INVALID_PARAMETERS':'UPSTREAM_HTTP',status===409?'GPU занят предыдущей задачей.':status===422?'GPU отклонил параметры генерации. Проверьте размеры, шаги и выбранные режимы.':`Туннель/движок ответил HTTP ${status}. Проверьте GPU-сервер и повторите запрос.`,status===409?409:502));
 if(binary){if(!String(res.headers['content-type']).startsWith('image/png')||data.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')return finish(new AppError('INVALID_IMAGE','GPU вернул неверный формат изображения.',502));return finish(null,data)}
 try{finish(null,JSON.parse(data.toString('utf8')))}catch{finish(new AppError('INVALID_RESPONSE','Туннель вернул не JSON движка. Возможно, он уже остановлен.',502))}
 });});
 const deadline=setTimeout(()=>{finish(new AppError('CONNECTION_TIMEOUT',`GPU не ответил за ${Math.round(timeout/1000)} секунд. Проверьте туннель и GPU-сервер.`,504));req.destroy()},timeout);
 req.on('error',e=>finish(new AppError(e.code?.includes('CERT')||e.code==='EPROTO'?'TLS_ERROR':'TUNNEL_UNAVAILABLE',e.code?.includes('CERT')||e.code==='EPROTO'?'Ошибка защищённого соединения с туннелем.':'Туннель недоступен или соединение разорвано. Проверьте GPU-сервер.',502)));
 req.end(body);
 });
}
export function validateHealth(x){if(!x||x.engine!=='YOISAKI_ENGINE'||typeof x.engine_version!=='string'||!['READY','BUSY','LOADING','ERROR'].includes(x.state)||!(x.gpu_name===null||typeof x.gpu_name==='string')||!['vram_total_mb','vram_available_mb'].every(k=>x[k]===null||Number.isFinite(x[k])&&x[k]>=0))fail('INVALID_RESPONSE','Неверный ответ health от GPU.',502);if(x.state==='ERROR')fail('GPU_NOT_READY','Движок отвечает, но GPU не готов. Проверьте CUDA на GPU-сервере.',503);if((x.api_version!==undefined&&x.api_version!=='1.7.0')||x.engine_version!=='1.7.0'||x.capabilities?.controlnet!==true||x.capabilities?.sdpose!==true||x.capabilities?.img2img!==true)fail('ENGINE_UPGRADE_REQUIRED','Несовместимая версия движка. Требуется YOISAKI ENGINE v1.7.0.',409);return x}
export function engineDetail(data){
 let detail;try{detail=JSON.parse(data.toString()).detail}catch{return ''}
 if(Array.isArray(detail))detail=detail.find(d=>typeof d?.msg==='string')?.msg;
 if(typeof detail!=='string')return '';
 return detail.replace(/^Value error, /,'').replace(/[a-f0-9]{64}/g,'[СКРЫТО]').replace(/(?:\/[\w.-]+){2,}/g,'[путь]').replace(/\s+/g,' ').trim().slice(0,300);
}
export function validateModels(x){if(!x||!Array.isArray(x.models)||x.models.length>3000||x.models.some(m=>!m||!/^[a-f0-9]{32}$/.test(m.id)||typeof m.name!=='string'||m.name.length>300||!['checkpoint','lora','vae','controlnet'].includes(m.kind)||typeof m.architecture!=='string'||!(m.compatible===null||typeof m.compatible==='boolean')||!(m.size_bytes===null||Number.isFinite(m.size_bytes)&&m.size_bytes>=0)))fail('INVALID_RESPONSE','Некорректный список моделей от GPU.',502);return x.models}
export function validateGeneration(x,models){
 if(x?.clip_skip!=null)fail('INVALID_PARAMETERS','Clip Skip override is not supported; SDXL uses hidden_states[-2].');
 const int=(n,min,max)=>Number.isInteger(n)&&n>=min&&n<=max;
 if(!x||!MODES.includes(x.mode)||x.kind!==x.mode||typeof x.prompt!=='string'||!x.prompt.trim()||x.prompt.length>10000||typeof x.negative_prompt!=='string'||x.negative_prompt.length>10000||!int(x.width,256,1536)||!int(x.height,256,1536)||x.width%8||x.height%8||!int(x.steps,1,60)||!Number.isFinite(x.cfg_scale)||x.cfg_scale<1||x.cfg_scale>20||!int(x.batch_size,1,2)||x.width*x.height*x.batch_size>2097152||!int(x.seed,-1,2147483647)||!['Euler','Euler a','DPM++ 2M'].includes(x.sampler)||!['Normal','Karras'].includes(x.scheduler)||x.sampler==='Euler a'&&x.scheduler==='Karras'||!Array.isArray(x.lora_adapters)||x.lora_adapters.length>8)fail('INVALID_PARAMETERS','Неподдерживаемые параметры: Text2Img / Img2Img, до 60 шагов, batch до 2, не более 2 Мп суммарно.');
 validateControl(x.controlnet_config,x.regions||[]);
 const source=validateImg2Img(x);
 const available=(id,kind)=>models.some(m=>m.id===id&&m.kind===kind&&m.compatible!==false);
 if(!available(x.checkpoint_id,'checkpoint')||x.vae_id!=='auto'&&!available(x.vae_id,'vae')||x.lora_adapters.some(l=>!available(l.id,'lora')||!Number.isFinite(l.weight)||l.weight<0||l.weight>2))fail('MODEL_UNAVAILABLE','Выбранная модель недоступна или несовместима. Обновите библиотеку.');
 if(x.client_request_id!==undefined&&!/^[a-f0-9-]{36}$/.test(x.client_request_id))fail('INVALID_PARAMETERS','Invalid request ID');
 if(x.regions!==undefined){
  if(!Array.isArray(x.regions)||x.regions.length>3)fail('INVALID_PARAMETERS','Maximum 3 regions');
  for(const r of x.regions){
   if(!r||typeof r.name!=='string'||r.name.length>100||typeof r.enabled!=='boolean'||!['prompt','negative_prompt','trigger'].every(k=>typeof r[k]==='string'&&r[k].length<=(k==='trigger'?1000:10000))||!Number.isFinite(r.weight)||r.weight<0||r.weight>2||typeof r.mask!=='string'||r.mask.length>400000||!r.mask.startsWith('data:image/png;base64,')||typeof r.lora_id!=='string'||r.lora_id&&!available(r.lora_id,'lora'))fail('INVALID_PARAMETERS','Invalid region');
   if(r.enabled&&r.lora_id&&x.lora_adapters.some(a=>a.id===r.lora_id))fail('INVALID_PARAMETERS','Уберите региональную LoRA из общего стека');
  }
  if(x.regions.some(r=>r.enabled)&&(x.batch_size!==1||x.width*x.height>1048576))fail('INVALID_PARAMETERS','Regional: batch 1, до 1 Мп');
 }
 return Object.fromEntries(['client_request_id','regions','kind','mode','prompt','negative_prompt','checkpoint_id','vae_id','lora_adapters','width','height','steps','cfg_scale','sampler','scheduler','seed','batch_size','controlnet_config'].map(k=>[k,x[k]]).concat(Object.entries(source)));
}

// Capability declaration wins. Legacy 1.5.x engines implement regional requests
// but expose only engine_version in /health (including the 1.5.2.1 hotfix).
export function supportsRegionalControl(info){
 if(info?.engine!=='YOISAKI_ENGINE')return false;
 const capabilities=info.capabilities;
 if(capabilities&&Object.hasOwn(capabilities,'regional_control'))return capabilities.regional_control===true;
 return /^1\.5\.\d+(?:\.\d+)?$/.test(info.engine_version||'');
}
