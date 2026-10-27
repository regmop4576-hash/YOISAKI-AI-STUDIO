import {fail} from './errors.mjs';
import {providerHttp} from './provider-http.mjs';

// Official specification snapshot: docs/api/cloudcompute-openapi-2026-10-27.yaml.
// Its servers.url already includes /api/v1; paths duplicate this prefix. Use it ONCE.
export const CLOUDCOMPUTE_BASE='https://app.cloudcompute.ru/api/v1';
export const CC_KEY=/^cc-[A-Za-z0-9._~-]{8,500}$/;
export function validateKey(value){if(typeof value!=='string'||!CC_KEY.test(value.trim()))fail('CC_INVALID_KEY','Введите API-ключ CloudCompute вида cc-…');return value.trim()}
const id=v=>{if(!/^[A-Za-z0-9_-]{1,100}$/.test(String(v)))fail('CC_INVALID_ID','Некорректный ID инстанса.');return encodeURIComponent(v)};
const safe=(v,n=255)=>typeof v==='string'?v.replace(/cc-[A-Za-z0-9._~-]+/g,'[СКРЫТО]').replace(/[a-f0-9]{64}/g,'[СКРЫТО]').replace(/[\x00-\x1f]/g,' ').slice(0,n):typeof v==='number'?String(v):'';
export function instanceView(v){
 if(!v||typeof v!=='object'||!['string','number'].includes(typeof v.id))fail('CC_RESPONSE_SCHEMA','CloudCompute вернул инстанс без ID. Формат успешных ответов не описан в OpenAPI; требуется обновление адаптера.',502);
 return {id:String(v.id),name:safe(v.name||v.label)||String(v.id),status:safe(v.status||v.actual_status||v.state)||'UNKNOWN',gpu:safe(v.gpu_name||v.gpu?.name),label:safe(v.label)};
}
export function instanceList(x){const list=Array.isArray(x)?x:Array.isArray(x?.data)?x.data:Array.isArray(x?.instances)?x.instances:x?.data?.instances;
 if(!Array.isArray(list))fail('CC_RESPONSE_SCHEMA','CloudCompute вернул неизвестный формат списка инстансов. Список не считается обновлённым.',502);
 return list.map(instanceView);
}
export function validatePatch(b){
 if(!b||Array.isArray(b)||Object.keys(b).some(k=>!['name','label','expires_at'].includes(k))||!Object.keys(b).length)fail('CC_INVALID_UPDATE','Разрешены только name, label, expires_at.');
 for(const [k,v] of Object.entries(b))if(typeof v!=='string'||!v.trim()||v.length>(k==='label'?100:255)||/[\x00-\x1f]/.test(v))fail('CC_INVALID_UPDATE','Некорректное поле '+k);
 if(b.expires_at&&(!Number.isFinite(Date.parse(b.expires_at))||Date.parse(b.expires_at)<=Date.now()))fail('CC_INVALID_UPDATE','Срок аренды должен быть в будущем. Допустимый предел проверяет CloudCompute.');
 return b;
}
export function validateCreate(b){
 const allowed=['ask_id','name','template_image','disk_gb','max_price_hour_minor','currency'];
 if(!b||Object.keys(b).some(k=>!allowed.includes(k))||!Number.isSafeInteger(b.ask_id)||b.ask_id<1)fail('CC_INVALID_CREATE','Нужен положительный ask_id выбранного предложения.');
 if(typeof b.name!=='string'||!b.name.trim()||b.name.length>255)fail('CC_INVALID_CREATE','Укажите имя инстанса.');
 if(typeof b.template_image!=='string'||b.template_image.length>255||!/^([a-z0-9][a-z0-9._\/-]*)(?::[@a-zA-Z0-9][@a-zA-Z0-9._-]*|@sha256:[a-fA-F0-9]{64})?$/.test(b.template_image))fail('CC_INVALID_CREATE','Укажите опубликованный Docker-образ.');
 if(!Number.isSafeInteger(b.disk_gb)||b.disk_gb<8||b.disk_gb>100000||!Number.isSafeInteger(b.max_price_hour_minor)||b.max_price_hour_minor<1||!/^RUB$/.test(b.currency))fail('CC_INVALID_CREATE','Нужны размер диска ≥8 ГБ и лимит цены в копейках (RUB).');
 return {...b,auto_select:false,strict_offer:true};
}
export class CloudComputeAPI{
 constructor(secrets,http=providerHttp){this.secrets=secrets;this.http=http}
 async request(method,path,body,key=this.secrets.cloudKey(),{maxBytes}={}){
  if(!key)fail('CC_NOT_CONFIGURED','Сначала сохраните API-ключ CloudCompute.',409);
  const {status,json}=await this.http(CLOUDCOMPUTE_BASE+path,{method,headers:{Authorization:'Bearer '+key,Accept:'application/json','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),...(maxBytes?{maxBytes}:{})});
  if(status<200||status>=300){const message=safe(json?.error?.message||json?.message,400).split(key).join('[СКРЫТО]');const labels={401:'API-ключ отклонён',403:'Недостаточно прав',404:'Инстанс или операция не найдены',422:'Параметры отклонены',429:'Лимит запросов'};fail('CC_HTTP_'+status,`CloudCompute HTTP ${status}: ${labels[status]||'Ошибка API'}${message?' — '+message:''}`,status>=400&&status<500?status:502)}
  return json;
 }
 async save(key){key=validateKey(key);const data=await this.request('GET','/instances',undefined,key);await this.secrets.setCloudKey(key);return data}
 async list(){return {instances:instanceList(await this.request('GET','/instances')),updated_at:Date.now(),stale:false}}
 detail(value){return this.request('GET','/instances/'+id(value))}
 patch(value,body){return this.request('PATCH','/instances/'+id(value),validatePatch(body))}
 remove(value){return this.request('DELETE','/instances/'+id(value))}
 create(body){return this.request('POST','/instances',validateCreate(body))}
 // v1.7.5: GET /offers (documented path; no query parameters are documented, so none are sent).
 offers(){return this.request('GET','/offers',undefined,undefined,{maxBytes:16*1024*1024})}
 // v1.7.5: a creation body built and validated by cloudcompute-deploy.mjs createBody() (adds onstart).
 deploy(body){return this.request('POST','/instances',body)}
}
