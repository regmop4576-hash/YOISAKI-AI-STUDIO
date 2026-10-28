import {fail,publicError} from './errors.mjs';
import {offerList,REQUIREMENTS} from './cloudcompute-deploy.mjs';

// v1.7.7 GPU availability monitor over the documented GET /offers (no scraping, no undocumented query parameters).
// One shared snapshot for every open page, so several tabs never multiply API calls:
//  - manual refresh and optional automatic refresh (server-side timer, 30 s … 30 min, stops by itself after a limit
//    and immediately on request); never more than one upstream request per MIN_GAP_MS whoever asks;
//  - HTTP 429: Retry-After is honoured, otherwise exponential backoff (60 s … 15 min); network/5xx: 30 s … 10 min;
//    401/403/no key: automatic refresh stops (it cannot succeed by repetition);
//  - change detection: offers that disappeared since the previous successful refresh, offers refused by CloudCompute
//    at creation ("taken"), and NEW offers matching the user's filters → one notification per offer (no duplicates);
//    the first successful refresh is a baseline and never notifies.
// The monitor never creates or reserves anything: renting always needs the user's explicit confirmation.
export const MONITOR_LIMITS={min_interval_s:30,max_interval_s:1800,default_interval_s:60,min_gap_ms:20000,max_auto_minutes:480,default_auto_minutes:120};
export const DEFAULT_FILTERS={gpu_count:1,min_vram_gb:16,preferred_vram_gb:24,max_price_rub:30,min_disk_gb:60,require_known_cuda:true,name:'',sort:'price'};
const SORTS=['price','vram','preferred','reliability','newest'];
const GONE_KEEP_MS=30*60000,TAKEN_KEEP_MS=15*60000,NOTIFY_KEEP=20,VRAM_TOLERANCE=0.9;

const int=(v,min,max,fallback)=>Number.isSafeInteger(Number(v))&&Number(v)>=min&&Number(v)<=max?Number(v):fallback;
const number=(v,min,max,fallback)=>Number.isFinite(Number(v))&&Number(v)>=min&&Number(v)<=max?Math.round(Number(v)*100)/100:fallback;
export function validateFilters(f={},{strict=false}={}){
 if(f===null||typeof f!=='object'||Array.isArray(f))fail('MONITOR_INVALID','Некорректные фильтры.');
 const bad=k=>strict&&f[k]!==undefined;
 const out={
  gpu_count:int(f.gpu_count,1,16,DEFAULT_FILTERS.gpu_count),
  min_vram_gb:number(f.min_vram_gb,8,256,DEFAULT_FILTERS.min_vram_gb),
  preferred_vram_gb:number(f.preferred_vram_gb,8,256,DEFAULT_FILTERS.preferred_vram_gb),
  max_price_rub:number(f.max_price_rub,1,100000,DEFAULT_FILTERS.max_price_rub),
  min_disk_gb:int(f.min_disk_gb,REQUIREMENTS.min_disk_gb,100000,DEFAULT_FILTERS.min_disk_gb),
  require_known_cuda:f.require_known_cuda===undefined?DEFAULT_FILTERS.require_known_cuda:f.require_known_cuda===true,
  name:typeof f.name==='string'?f.name.replace(/[\x00-\x1f]/g,'').trim().slice(0,40):'',
  sort:SORTS.includes(f.sort)?f.sort:DEFAULT_FILTERS.sort,
 };
 for(const k of ['gpu_count','min_vram_gb','preferred_vram_gb','max_price_rub','min_disk_gb'])if(bad(k)&&Number(f[k])!==out[k])fail('MONITOR_INVALID','Некорректное значение фильтра: '+k);
 return out;
}
export function validateSettings(s={},previous={}){
 if(s===null||typeof s!=='object'||Array.isArray(s))fail('MONITOR_INVALID','Некорректные настройки мониторинга.');
 return {
  filters:validateFilters(s.filters??previous.filters??{},{strict:s.filters!==undefined}),
  interval_s:int(s.interval_s??previous.interval_s,MONITOR_LIMITS.min_interval_s,MONITOR_LIMITS.max_interval_s,MONITOR_LIMITS.default_interval_s),
  auto_minutes:int(s.auto_minutes??previous.auto_minutes,5,MONITOR_LIMITS.max_auto_minutes,MONITOR_LIMITS.default_auto_minutes),
  browser_notifications:(s.browser_notifications??previous.browser_notifications)===true,
 };
}

// Does one parsed offer (offerView) satisfy the filters? Never decides on the GPU name alone.
export function matchOffer(o,f,{taken}={}){
 const reasons=[];
 if(taken)reasons.push('CloudCompute отказал в создании: хост занят ('+taken+').');
 if(!o.compatible)reasons.push(...o.reasons);
 if(o.gpus!==f.gpu_count)reasons.push(`${o.gpus} GPU, нужно ${f.gpu_count}.`);
 if(o.vram_mb==null)reasons.push('VRAM не указан.');else if(o.vram_mb<f.min_vram_gb*1024*VRAM_TOLERANCE)reasons.push(`VRAM ${Math.round(o.vram_mb/1024)} ГБ < ${f.min_vram_gb} ГБ.`);
 if(!o.price)reasons.push('Нет цены.');
 else if(!o.price.verified||o.price.minor==null)reasons.push('Единицы цены не подтверждены.');
 else if(o.price.currency!=='RUB')reasons.push(`Цена в ${o.price.currency||'неизвестной валюте'}: сравнение с лимитом в рублях невозможно.`);
 else if(o.price.minor>Math.round(f.max_price_rub*100))reasons.push(`Цена ${(o.price.minor/100).toFixed(2)} ₽/ч > ${f.max_price_rub} ₽/ч.`);
 if(o.disk_gb!=null&&o.disk_gb<f.min_disk_gb)reasons.push(`Диск до ${Math.floor(o.disk_gb)} ГБ < ${f.min_disk_gb} ГБ.`);
 if(f.require_known_cuda&&o.cuda==null)reasons.push('Версия CUDA не указана.');
 if(f.name&&!o.gpu.toLowerCase().includes(f.name.toLowerCase()))reasons.push('Не совпадает с фильтром названия.');
 return {ok:!reasons.length,reasons:[...new Set(reasons)],preferred:o.vram_mb!=null&&o.vram_mb>=f.preferred_vram_gb*1024*VRAM_TOLERANCE};
}
export function sortOffers(list,sort){
 const price=o=>o.price?.verified&&o.price.minor!=null?o.price.minor:Infinity;
 const by={price:(a,b)=>price(a)-price(b)||(b.vram_mb||0)-(a.vram_mb||0),vram:(a,b)=>(b.vram_mb||0)-(a.vram_mb||0)||price(a)-price(b),
  preferred:(a,b)=>(b.match.preferred-a.match.preferred)||price(a)-price(b),reliability:(a,b)=>(b.reliability??-1)-(a.reliability??-1)||price(a)-price(b),
  newest:(a,b)=>(b.first_seen||0)-(a.first_seen||0)||price(a)-price(b)}[sort]||((a,b)=>price(a)-price(b));
 return [...list].sort((a,b)=>(b.match.ok-a.match.ok)||by(a,b));
}
const brief=o=>({id:o.id,gpu:o.gpu,gpus:o.gpus,vram_mb:o.vram_mb,price_minor:o.price?.minor??null,currency:o.price?.currency||'',disk_gb:o.disk_gb});

export class OfferMonitor{
 constructor({fetchOffers,settings={},saveSettings=async()=>{},now=()=>Date.now(),setTimer=(fn,ms)=>{const t=setTimeout(fn,ms);t.unref?.();return t},clearTimer=t=>clearTimeout(t),minGapMs=MONITOR_LIMITS.min_gap_ms}){
  Object.assign(this,{fetchOffers,saveSettings,now,setTimer,clearTimer,minGapMs});
  this.settings=validateSettings(settings||{});
  this.offers=[];this.rejected=0;this.updatedAt=null;this.lastAttemptAt=0;this.error=null;this.failures=0;this.backoffUntil=0;this.rateLimited=false;
  this.baseline=false;this.seen=new Map();this.gone=new Map();this.taken=new Map();this.notifications=[];this.notified=new Set();
  this.auto={on:false,started_at:null,stops_at:null,next_run_at:null,stop_reason:''};this.timer=null;this.inFlight=null;this.requests=0;
 }
 async configure(input){this.settings=validateSettings(input,this.settings);await this.saveSettings(this.settings);if(this.auto.on)this.schedule(this.settings.interval_s*1000);return this.view()}
 // Manual refresh: obeys the minimum gap (returns the shared snapshot) and an active 429 backoff (refused with the time).
 // force: an explicit verification before a paid creation; it skips the gap but never a rate-limit backoff.
 async refresh({force=false,reason='manual'}={}){
  const now=this.now();
  if(this.rateLimited&&now<this.backoffUntil)fail('CC_RATE_LIMITED',`CloudCompute ограничил частоту запросов. Повтор через ${Math.ceil((this.backoffUntil-now)/1000)} с.`,429);
  if(this.inFlight)return this.inFlight;
  if(!force&&this.updatedAt&&now-this.lastAttemptAt<this.minGapMs)return {...this.view(),cached:true};
  this.inFlight=this.fetch(reason).finally(()=>{this.inFlight=null});
  return this.inFlight;
 }
 async fetch(reason){
  this.lastAttemptAt=this.now();this.requests++;
  try{
   const {offers,rejected}=offerList(await this.fetchOffers());
   this.apply(offers,this.now());this.rejected=rejected;this.error=null;this.failures=0;this.rateLimited=false;this.backoffUntil=0;
   return this.view();
  }catch(e){
   this.failures++;const now=this.now(),pe=publicError(e);
   if(e.code==='CC_HTTP_429'){this.rateLimited=true;const wait=Math.max(Number(e.retry_after)||0,Math.min(900,60*2**(this.failures-1)));this.backoffUntil=now+wait*1000;this.error={code:'CC_RATE_LIMITED',message:`CloudCompute: лимит запросов (HTTP 429). Пауза ${wait} с${e.retry_after?' (Retry-After)':''}.`,at:now}}
   else{this.backoffUntil=now+Math.min(600,30*2**(this.failures-1))*1000;this.error={code:e.code||'LOCAL_ERROR',message:pe.error,at:now}}
   if(['CC_HTTP_401','CC_HTTP_403','CC_NOT_CONFIGURED'].includes(e.code))this.stop('Автообновление остановлено: '+pe.error);
   if(reason!=='auto'){if(this.rateLimited)fail('CC_RATE_LIMITED',this.error.message,429);throw e}
   return this.view();
  }
 }
 apply(list,now){
  const prev=new Map(this.offers.map(o=>[o.id,o])),current=new Set(list.map(o=>o.id));
  for(const [id,o] of prev)if(!current.has(id))this.gone.set(id,{...brief(o),gone_at:now});
  for(const id of current)this.gone.delete(id);
  for(const [id,g] of this.gone)if(now-g.gone_at>GONE_KEEP_MS)this.gone.delete(id);
  for(const [id,t] of this.taken)if(now-t.at>TAKEN_KEEP_MS)this.taken.delete(id);
  const fresh=[];
  for(const o of list){if(!this.seen.has(o.id)){this.seen.set(o.id,now);if(this.baseline)fresh.push(o)}o.first_seen=this.seen.get(o.id)}
  if(this.seen.size>5000)for(const id of [...this.seen.keys()].slice(0,this.seen.size-5000))if(!current.has(id))this.seen.delete(id);
  this.offers=list;this.updatedAt=now;
  if(this.baseline)for(const o of fresh){
   const m=matchOffer(o,this.settings.filters,{taken:this.taken.get(o.id)?.message});
   if(!m.ok||this.notified.has(o.id))continue;
   this.notified.add(o.id);this.notifications.push({key:'offer-'+o.id+'-'+now,offer:brief(o),preferred:m.preferred,at:now,acknowledged:false});
  }
  this.notifications=this.notifications.slice(-NOTIFY_KEEP);this.baseline=true;
 }
 // CloudCompute refused a creation for this offer as occupied: never offered as matching again for a while.
 markTaken(id,message){const o=this.offers.find(x=>x.id===id);this.taken.set(id,{at:this.now(),message:String(message||'занято').slice(0,200),offer:o?brief(o):{id}})}
 acknowledge(keys){const set=new Set(Array.isArray(keys)?keys.map(String):[]);for(const n of this.notifications)if(set.has(n.key)||set.has('*'))n.acknowledged=true;return this.view()}
 alternatives(excludeId,limit=5){const f=this.settings.filters;return sortOffers(this.offers.filter(o=>o.id!==excludeId).map(o=>({...o,match:matchOffer(o,f,{taken:this.taken.get(o.id)?.message})})).filter(o=>o.match.ok),'price').slice(0,limit).map(o=>({...brief(o),preferred:o.match.preferred,cuda:o.cuda,reliability:o.reliability}))}
 start(){
  const now=this.now();this.auto={on:true,started_at:now,stops_at:now+this.settings.auto_minutes*60000,next_run_at:null,stop_reason:''};
  this.schedule(0);return this.view();
 }
 stop(reason='Остановлено пользователем.'){if(this.timer)this.clearTimer(this.timer);this.timer=null;this.auto={...this.auto,on:false,next_run_at:null,stop_reason:reason};return this.view()}
 schedule(delay){
  if(this.timer)this.clearTimer(this.timer);
  const now=this.now(),wait=Math.max(delay,this.backoffUntil-now,0);
  if(now+wait>this.auto.stops_at){this.stop(`Автообновление остановлено через ${this.settings.auto_minutes} мин (ограничение по времени).`);return}
  this.auto.next_run_at=now+wait;
  this.timer=this.setTimer(async()=>{this.timer=null;if(!this.auto.on)return;try{await this.refresh({reason:'auto'})}catch{}if(this.auto.on)this.schedule(this.settings.interval_s*1000)},wait);
 }
 view(){
  const now=this.now(),f=this.settings.filters;
  const offers=sortOffers(this.offers.map(o=>({...o,taken:this.taken.has(o.id),match:matchOffer(o,f,{taken:this.taken.get(o.id)?.message})})),f.sort);
  return {settings:this.settings,limits:MONITOR_LIMITS,requirements:REQUIREMENTS,offers:offers.slice(0,200),total:offers.length,matching:offers.filter(o=>o.match.ok).length,rejected:this.rejected,
   updated_at:this.updatedAt,last_attempt_at:this.lastAttemptAt||null,stale:!!this.error&&!!this.updatedAt,error:this.error,
   rate_limit:this.rateLimited&&now<this.backoffUntil?{until:this.backoffUntil,retry_in_s:Math.ceil((this.backoffUntil-now)/1000)}:null,
   backoff_until:this.backoffUntil>now?this.backoffUntil:null,auto:{...this.auto},
   gone:[...this.gone.values()].sort((a,b)=>b.gone_at-a.gone_at).slice(0,30),taken:[...this.taken.entries()].map(([id,t])=>({id,at:t.at,message:t.message,offer:t.offer})),
   notifications:[...this.notifications].reverse(),requests:this.requests};
 }
}
