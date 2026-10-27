import fs from 'node:fs/promises';
import path from 'node:path';
import {AppError,fail} from './errors.mjs';
import {httpsJson,scrub} from './https-json.mjs';
// v1.7.3 CloudCompute REST API adapter (instance discovery and lifecycle) of the LOCAL server.
//
// What is known for certain (CloudCompute API access panel): base URL https://app.cloudcompute.ru/api/v1,
// "Authorization: Bearer cc-…", categories Inference / GPU instances / SSH keys, documentation at
// https://cloudcompute.ru/docs/api. The individual endpoints, their request and response schemas could NOT be
// read while this release was developed (the documentation host was unreachable), so NO endpoint is hard-coded:
// inventing one would risk billable calls to undocumented methods.
//
// The operations are therefore described by a small, strictly validated contract (JSON) that is checked against
// the official documentation once: <data folder>/cloudcompute-api.json (see cloudcompute-api.example.json).
// Without a verified contract the API key can still be stored safely, and every instance button explains why it
// is unavailable; nothing pretends to work. Only GET and POST exist in the contract: deleting an instance is
// deliberately not implementable through it.
//
// Security: the host is a constant (no SSRF), TLS is verified, redirects are refused, the key is sent only in
// the Authorization header to that host, never to the GPU engine, the page, logs or URLs.
export const API_HOST='app.cloudcompute.ru';
export const API_BASE='/api/v1';
export const DOCS_URL='https://cloudcompute.ru/docs/api';
export const PANEL_URL='https://app.cloudcompute.ru/';
export const KEY_RE=/^cc-[A-Za-z0-9._~-]{8,256}$/;
export const INSTANCE_ID_RE=/^[A-Za-z0-9_.:-]{1,128}$/;
export const STATUSES=['RUNNING','STARTING','STOPPING','STOPPED','ERROR','UNKNOWN'];
const OPERATIONS=['validate','list','get','start','stop'];
const FIELDS=['id','name','status','gpu','gpu_count','disk_gb','price_per_hour','image'];
const PATH_RE=/^\/(?:[A-Za-z0-9_.~-]+|\{id\})(?:\/(?:[A-Za-z0-9_.~-]+|\{id\}))*$/;
const POINTER_RE=/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){0,5}$/;
export const CONTRACT_FILE='cloudcompute-api.json';
export const UNVERIFIED={verified:false,verified_against:'',operations:{},fields:{},status_map:{}};

export function validateKey(raw){
 const key=typeof raw==='string'?raw.trim():'';
 if(!KEY_RE.test(key))fail('CC_INVALID_KEY','Ключ CloudCompute API должен начинаться с «cc-» и состоять из латинских букв, цифр и символов ._~- (без пробелов). Скопируйте его целиком на странице «Доступ к API».');
 return key;
}
// Strict contract parser: anything unexpected disables the whole contract instead of guessing.
export function parseContract(raw){
 const bad=why=>fail('CC_CONTRACT_INVALID','Файл описания CloudCompute API неверен: '+why+'.');
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.version!==1)bad('нужен объект с "version": 1');
 if(typeof raw.verified_against!=='string'||raw.verified_against.length<8||raw.verified_against.length>300)bad('поле "verified_against" (ссылка на раздел документации и дата проверки) обязательно');
 const ops={};
 for(const [name,op] of Object.entries(raw.operations||{})){
  if(!OPERATIONS.includes(name))bad(`неизвестная операция "${name}"`);
  if(!op||typeof op!=='object'||!['GET','POST'].includes(op.method)||typeof op.path!=='string'||op.path.length>200||!PATH_RE.test(op.path)||op.path.includes('..'))bad(`операция "${name}": method GET/POST и относительный path вида /instances/{id}/start`);
  const needsId=['get','start','stop'].includes(name);if(needsId!==op.path.includes('{id}'))bad(`операция "${name}": ${needsId?'нужен':'не нужен'} {id} в path`);
  if(name!=='list'&&name!=='validate'&&op.items!==undefined||op.items!==undefined&&op.items!==''&&!POINTER_RE.test(op.items))bad(`операция "${name}": неверное поле items`);
  if(op.item!==undefined&&op.item!==''&&!POINTER_RE.test(op.item))bad(`операция "${name}": неверное поле item`);
  let body;if(op.body!==undefined){if(op.method!=='POST'||!op.body||typeof op.body!=='object'||Array.isArray(op.body))bad(`операция "${name}": body — объект и только для POST`);body=JSON.stringify(op.body);if(body.length>2000)bad(`операция "${name}": body слишком большой`)}
  ops[name]={method:op.method,path:op.path,items:op.items??'',item:op.item??'',body};
 }
 if(!ops.list&&!ops.get&&(ops.start||ops.stop))bad('для запуска/остановки нужна операция list или get, чтобы видеть статус');
 const fields={};
 for(const [k,v] of Object.entries(raw.fields||{})){if(!FIELDS.includes(k)||typeof v!=='string'||!POINTER_RE.test(v))bad(`поле "${k}"`);fields[k]=v}
 if((ops.list||ops.get)&&(!fields.id||!fields.status))bad('нужны fields.id и fields.status');
 const status_map={};
 for(const [k,v] of Object.entries(raw.status_map||{})){if(typeof k!=='string'||k.length>60||!STATUSES.includes(v))bad(`status_map "${k}"`);status_map[k.toLowerCase()]=v}
 if((ops.list||ops.get)&&!Object.keys(status_map).length)bad('нужна таблица status_map');
 return {verified:true,verified_against:scrub(raw.verified_against,300),operations:ops,fields,status_map};
}
export async function loadContract(dataDir){
 const file=path.join(dataDir,CONTRACT_FILE);
 let text;try{text=await fs.readFile(file,'utf8')}catch(e){if(e.code==='ENOENT')return {contract:UNVERIFIED,error:''};return {contract:UNVERIFIED,error:'Файл описания CloudCompute API не читается.'}}
 try{return {contract:parseContract(JSON.parse(text)),error:''}}catch(e){return {contract:UNVERIFIED,error:e instanceof AppError?e.message:'Файл описания CloudCompute API — не JSON.'}}
}
const pick=(obj,pointer)=>{if(!pointer)return obj;let v=obj;for(const k of pointer.split('.')){if(v===null||typeof v!=='object')return undefined;v=v[k]}return v};
const short=(v,max=120)=>v===undefined||v===null?null:typeof v==='string'||typeof v==='number'?scrub(String(v),max)||null:null;
const num=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:typeof v==='string'&&/^\d+(\.\d+)?$/.test(v)?Number(v):null;
export function normalizeInstance(raw,contract){
 if(!raw||typeof raw!=='object')return null;
 const f=contract.fields;const id=pick(raw,f.id);const idText=typeof id==='number'?String(id):id;
 if(typeof idText!=='string'||!INSTANCE_ID_RE.test(idText))return null;
 const rawStatus=short(pick(raw,f.status),60);
 return {id:idText,name:short(pick(raw,f.name))||idText,status:rawStatus&&contract.status_map[rawStatus.toLowerCase()]||'UNKNOWN',provider_status:rawStatus||'',
  gpu:short(pick(raw,f.gpu)),gpu_count:num(pick(raw,f.gpu_count)),disk_gb:num(pick(raw,f.disk_gb)),price_per_hour:num(pick(raw,f.price_per_hour)),image:short(pick(raw,f.image),160)};
}
function providerMessage(json,text){const m=json&&(typeof json.message==='string'?json.message:typeof json.error==='string'?json.error:typeof json.detail==='string'?json.detail:typeof json.error?.message==='string'?json.error.message:'');return scrub(m||'',240)}
export class CloudComputeApi{
 constructor({contract=UNVERIFIED,request=httpsJson}={}){this.contract=contract;this.request=request}
 capabilities(){const o=this.contract.operations;return {validate:!!(o.validate||o.list),list:!!o.list,get:!!(o.get||o.list),start:!!o.start,stop:!!o.stop}}
 async call(key,name,id){
  const op=this.contract.operations[name];if(!op)fail('CC_UNSUPPORTED','Эта операция не описана в проверенном описании CloudCompute API.',409);
  if(op.path.includes('{id}')&&!INSTANCE_ID_RE.test(String(id)))fail('CC_INVALID_INSTANCE','Неверный идентификатор инстанса.');
  const route=API_BASE+op.path.replace('{id}',encodeURIComponent(String(id)));
  const r=await this.request({host:API_HOST,path:route,method:op.method,prefix:'CC',timeout:20000,headers:{Authorization:'Bearer '+validateKey(key),...(op.body!==undefined?{'Content-Type':'application/json'}:{})},body:op.method==='POST'?op.body??'{}':undefined});
  const detail=providerMessage(r.json,r.text);const tail=detail?` Ответ CloudCompute: «${detail}».`:'';
  if(r.status>=300&&r.status<400)throw new AppError('CC_REDIRECT','CloudCompute API перенаправил запрос: адрес API в описании устарел. Сверьте описание с документацией.',502);
  if(r.status===401||r.status===403)throw new AppError('CC_AUTH_REJECTED',`CloudCompute отклонил API-ключ (HTTP ${r.status}): ключ неверен, отозван или не имеет доступа к GPU-инстансам. Создайте новый ключ на странице «Доступ к API».`+tail,400);
  if(r.status===402)throw new AppError('CC_PAYMENT','CloudCompute: недостаточно средств на балансе (HTTP 402).'+tail,409);
  if(r.status===404)throw new AppError(name==='list'||name==='validate'?'CC_UNSUPPORTED':'CC_NOT_FOUND',name==='list'||name==='validate'?'CloudCompute API не знает этот адрес (HTTP 404): описание API не соответствует документации.':'Инстанс не найден в аккаунте CloudCompute (HTTP 404): он удалён или принадлежит другому аккаунту.',name==='list'||name==='validate'?502:404);
  if(r.status===405||r.status===501)throw new AppError('CC_UNSUPPORTED',`CloudCompute API не поддерживает эту операцию (HTTP ${r.status}). Выполните её в панели CloudCompute.`,502);
  if(r.status===409||r.status===422||r.status===400)throw new AppError('CC_REJECTED',`CloudCompute отклонил операцию (HTTP ${r.status}).`+tail,409);
  if(r.status===429)throw new AppError('CC_RATE_LIMITED','CloudCompute API: слишком много запросов. Подождите минуту.',429);
  if(r.status>=500)throw new AppError('CC_UNAVAILABLE',`CloudCompute API временно недоступен (HTTP ${r.status}).`,502);
  if(r.status<200||r.status>=300)throw new AppError('CC_UNAVAILABLE',`Неожиданный ответ CloudCompute API (HTTP ${r.status}).`,502);
  return r.json;
 }
 async validate(key){await this.call(key,this.contract.operations.validate?'validate':'list');return true}
 async list(key){
  const json=await this.call(key,'list');const arr=pick(json,this.contract.operations.list.items);
  if(!Array.isArray(arr))throw new AppError('CC_INVALID_RESPONSE','CloudCompute API вернул список инстансов в неожиданном формате: описание API не соответствует ответу.',502);
  return arr.slice(0,200).map(x=>normalizeInstance(x,this.contract)).filter(Boolean);
 }
 async get(key,id){
  if(this.contract.operations.get){const json=await this.call(key,'get',id);const x=normalizeInstance(pick(json,this.contract.operations.get.item),this.contract);if(!x)throw new AppError('CC_INVALID_RESPONSE','CloudCompute API вернул инстанс в неожиданном формате.',502);return x}
  const found=(await this.list(key)).find(x=>x.id===id);if(!found)throw new AppError('CC_NOT_FOUND','Инстанс не найден в аккаунте CloudCompute: он удалён или принадлежит другому аккаунту.',404);return found;
 }
 async start(key,id){await this.call(key,'start',id)}
 async stop(key,id){await this.call(key,'stop',id)}
}
