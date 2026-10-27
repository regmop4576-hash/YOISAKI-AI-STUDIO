import {randomBytes} from 'node:crypto';
import {fail,publicError} from './errors.mjs';
import {instanceView} from './cloudcompute-api.mjs';

// v1.7.5 zero-terminal CloudCompute deployment: GPU offers → paid instance with the prebuilt YOISAKI ENGINE image →
// automatic engine start (onstart) → signed stages and address (rendezvous) → engine connection → Drive models.
// Only documented CloudCompute fields are sent (docs/api/cloudcompute-openapi-2026-10-27.yaml: GET /offers,
// POST /instances with ask_id, strict_offer, template_image, disk_gb, offer_disk_space, max_price_hour_minor,
// currency, onstart). The OpenAPI file describes no success response schemas, so every response is parsed
// defensively: an unknown shape is an explicit error, never a guess presented as fact.

export const ENGINE_IMAGE='ghcr.io/regmop4576-hash/yoisaki-ai-studio/engine:1.7.5';
export const IMAGE_RE=/^([a-z0-9][a-z0-9._\/-]*)(?::[@a-zA-Z0-9][@a-zA-Z0-9._-]*|@sha256:[a-fA-F0-9]{64})?$/;
// SDXL / Illustrious XL with ControlNet and Multi-LoRA: 12 GB is the practical minimum, 16 GB+ recommended.
// torch 2.10 cu128 wheels need a host driver that supports CUDA 12.8.
export const REQUIREMENTS={min_vram_mb:12288,recommended_vram_mb:16384,min_cuda:12.8,min_disk_gb:40,default_disk_gb:80,image_size_note_gb:13};
export const DEPLOY_STAGES=['CREATING','GPU_CREATED','INSTANCE_INITIALIZING','DOCKER_IMAGE_READY','ENGINE_STARTING','ENGINE_HEALTH_CHECK','GPU_READY'];
export const END_STAGES=['FAILED','TIMEOUT','INSTANCE_GONE'];
const TOKEN=/^[a-f0-9]{64}$/,INSTANCE_ID=/^[A-Za-z0-9_-]{1,100}$/;

const num=v=>typeof v==='number'&&Number.isFinite(v)?v:typeof v==='string'&&/^\s*-?\d+(\.\d+)?\s*$/.test(v)?Number(v):null;
const text=(v,n=120)=>typeof v==='string'?v.replace(/cc-[A-Za-z0-9._~-]+/g,'[СКРЫТО]').replace(/[a-f0-9]{64}/g,'[СКРЫТО]').replace(/[\x00-\x1f]/g,' ').trim().slice(0,n):typeof v==='number'&&Number.isFinite(v)?String(v):'';
const pick=(o,keys)=>{for(const k of keys){const v=k.split('.').reduce((x,p)=>x&&typeof x==='object'?x[p]:undefined,o);if(v!==undefined&&v!==null&&v!=='')return {key:k,value:v}}return null};

// Price of one offer. Units are only trusted when the field name or the CloudCompute documentation fixes them:
//  *_minor / *_kopecks → minor units; *_rub → roubles; price_hour → kopecks (documented for the launch API).
// Anything else (e.g. a bare "price") is shown but marked unverified and cannot be used for a one-tap creation.
export function offerPrice(o){
 const currencyOf=fallback=>{const c=pick(o,['currency','price_currency','price.currency']);const v=typeof c?.value==='string'?c.value.trim().toUpperCase():'';return /^[A-Z]{3}$/.test(v)?v:fallback};
 const nested=o?.price&&typeof o.price==='object'?o.price:null;
 const minor=pick(o,['price_hour_minor','price_per_hour_minor','hourly_price_minor','price_minor','price_kopecks','price_hour_kopecks','dph_minor','price.amount_minor','price.minor']);
 if(minor&&num(minor.value)!==null&&num(minor.value)>=0){const cur=currencyOf(/kopeck/.test(minor.key)?'RUB':'');return {minor:Math.round(num(minor.value)),currency:cur,field:minor.key,verified:!!cur,basis:cur?'':'валюта не указана'}}
 const rub=pick(o,['price_rub','price_hour_rub','price_per_hour_rub','rub_per_hour','hourly_price_rub','dph_rub']);
 if(rub&&num(rub.value)!==null&&num(rub.value)>=0)return {minor:Math.round(num(rub.value)*100),currency:'RUB',field:rub.key,verified:true,basis:''};
 const hour=pick(o,['price_hour']);
 if(hour&&num(hour.value)!==null&&num(hour.value)>=0){const cur=currencyOf('RUB');return {minor:Math.round(num(hour.value)),currency:cur,field:'price_hour',verified:true,basis:'price_hour в API CloudCompute задаётся в копейках'}}
 const other=pick(o,['dph_total','dph','price_per_hour','hourly_price','price.amount','price.value','price',...(nested?[]:[])]);
 if(other&&num(other.value)!==null)return {minor:null,raw:num(other.value),currency:currencyOf(''),field:other.key,verified:false,basis:'единицы цены не описаны в API'};
 return null;
}

export function offerView(o){
 if(!o||typeof o!=='object')fail('CC_RESPONSE_SCHEMA','CloudCompute вернул предложение неизвестного формата.',502);
 const idField=pick(o,['ask_id','id','offer_id','ask_contract_id']);const id=num(idField?.value);
 if(!Number.isSafeInteger(id)||id<1)fail('CC_RESPONSE_SCHEMA','CloudCompute вернул предложение без числового ID (ask_id). Формат GET /offers не описан в OpenAPI; требуется обновление адаптера.',502);
 const gpus=num(pick(o,['num_gpus','gpu_count','gpus','gpu.count'])?.value)||1;
 let vram=null,vramField='';
 const mb=pick(o,['gpu_ram','gpu_ram_mb','vram_mb','gpu_memory_mb','gpu.memory_mb','gpu.ram']);const gb=pick(o,['vram_gb','gpu_ram_gb','gpu_memory_gb','gpu.memory_gb']);
 if(mb&&num(mb.value)>0){const v=num(mb.value);vram=v<256?Math.round(v*1024):Math.round(v);vramField=mb.key}else if(gb&&num(gb.value)>0){vram=Math.round(num(gb.value)*1024);vramField=gb.key}
 const disk=num(pick(o,['disk_space','disk_gb','disk','storage_gb','disk_size'])?.value);
 const cuda=num(pick(o,['cuda_max_good','cuda_version','max_cuda','cuda'])?.value);
 let reliability=num(pick(o,['reliability2','reliability','reliability_score'])?.value);if(reliability!==null&&reliability<=1)reliability=Math.round(reliability*1000)/10;
 const price=offerPrice(o);
 // Storage price, when the API sends one, is shown verbatim with its field name (its unit is not documented).
 const storage=Object.entries(o).filter(([k,v])=>/(storage|disk).*(price|cost)|(price|cost).*(storage|disk)/i.test(k)&&num(v)!==null).slice(0,4).map(([k,v])=>({field:text(k,60),value:num(v)}));
 const unavailable=o.rentable===false||o.rented===true||o.available===false;
 const reasons=[],warnings=[];
 if(unavailable)reasons.push('Предложение уже занято.');
 if(vram===null)warnings.push('VRAM не указан в ответе API.');else if(vram<REQUIREMENTS.min_vram_mb)reasons.push(`VRAM ${Math.round(vram/1024)} ГБ: для SDXL нужно не меньше 12 ГБ.`);else if(vram<REQUIREMENTS.recommended_vram_mb)warnings.push('12–16 ГБ VRAM: ControlNet и несколько LoRA могут работать медленнее.');
 if(cuda!==null&&cuda<REQUIREMENTS.min_cuda)reasons.push(`Драйвер поддерживает CUDA ${cuda}; образу нужна CUDA 12.8+.`);
 if(disk!==null&&disk<REQUIREMENTS.min_disk_gb)reasons.push(`Диск до ${Math.floor(disk)} ГБ: нужно не меньше ${REQUIREMENTS.min_disk_gb} ГБ.`);
 if(!price)reasons.push('Цена не указана в ответе API.');else if(!price.verified)reasons.push('Цена получена, но её единицы не подтверждены документацией: используйте «Расширенные настройки».');
 if(gpus>1)warnings.push(`${gpus} GPU в предложении: движок использует один, оплачиваются все.`);
 return {id,gpu:text(pick(o,['gpu_name','gpu.name','gpu_model','gpu','model'])?.value)||'GPU',gpus,vram_mb:vram,vram_field:vramField,price,storage,disk_gb:disk,cuda,reliability,
  location:text(pick(o,['geolocation','country','location','region'])?.value,60),inet_down_mbps:num(pick(o,['inet_down','download_mbps'])?.value),
  compatible:!reasons.length,reasons,warnings};
}

export function offerList(json){
 const list=Array.isArray(json)?json:Array.isArray(json?.data)?json.data:Array.isArray(json?.offers)?json.offers:Array.isArray(json?.data?.offers)?json.data.offers:Array.isArray(json?.items)?json.items:null;
 if(!list)fail('CC_RESPONSE_SCHEMA','CloudCompute вернул неизвестный формат списка предложений GPU. Список не показан, чтобы не выдавать догадки за цены.',502);
 const out=[];let rejected=0;
 for(const raw of list.slice(0,2000)){try{out.push(offerView(raw))}catch{rejected++}}
 if(list.length&&!out.length)fail('CC_RESPONSE_SCHEMA','Ни одно предложение CloudCompute не распознано (нет числового ask_id).',502);
 out.sort((a,b)=>(b.compatible-a.compatible)||((a.price?.minor??Infinity)-(b.price?.minor??Infinity))||(b.vram_mb||0)-(a.vram_mb||0));
 return {offers:out,rejected};
}

export function validateToken(token){if(!TOKEN.test(token||''))fail('CC_INVALID_TOKEN','Внутренняя ошибка токена движка.',500);return token}
export function validateImage(image){if(typeof image!=='string'||image.length>255||!IMAGE_RE.test(image))fail('CC_INVALID_IMAGE','Укажите опубликованный Docker-образ вида registry/owner/name:версия.');return image}
const quote=v=>"'"+String(v).replace(/'/g,"'\\''")+"'";

// The CloudCompute "onstart" script (documented field, ≤ 50000 characters). It contains this instance's engine token:
// the provider stores it with the instance like any other instance setting; it is never logged by this app.
// Inside the YOISAKI image it hands over to cloudcompute/autostart-image.sh; on a VM with Docker it runs the image.
export function onstartScript({image,token}){
 validateImage(image);validateToken(token);
 return `#!/bin/bash
# YOISAKI AI STUDIO 1.7.5 · automatic YOISAKI ENGINE initialization for this instance (generated, do not share:
# it contains this instance's engine access token). Logs: /var/log/yoisaki-onstart.log or /tmp/yoisaki-onstart.log
set -u
umask 077
YOISAKI_IMAGE_REF=${quote(image)}
export YOISAKI_PROVISION_TOKEN=${quote(token)}
APP=\${YOISAKI_APP_DIR:-/opt/yoisaki}
LOG=/var/log/yoisaki-onstart.log
touch "$LOG" 2>/dev/null || LOG=/tmp/yoisaki-onstart.log
note() { printf '%s %s\\n' "$(date '+%F %T')" "$*" >>"$LOG"; }
if [ -x "$APP/cloudcompute/autostart-image.sh" ]; then
  note 'YOISAKI image detected: provisioning the engine.'
  "$APP/cloudcompute/autostart-image.sh" --provision >>"$LOG" 2>&1 || note 'autostart-image.sh --provision failed.'
elif command -v docker >/dev/null 2>&1; then
  note "Docker host detected: starting $YOISAKI_IMAGE_REF."
  D=\${YOISAKI_HOST_DATA:-/workspace/yoisaki-data}
  [ -d "$(dirname "$D")" ] || D=/var/lib/yoisaki-data
  mkdir -p "$D/config/engine" "$D/runtime/state" && chmod 700 "$D/config/engine"
  printf '%s\\n' "$YOISAKI_PROVISION_TOKEN" >"$D/config/engine/engine.token" && chmod 600 "$D/config/engine/engine.token"
  printf '%s\\n' '{"version": 1, "stable_link": true, "rendezvous": "ntfy"}' >"$D/config/engine/autostart.json"
  touch "$D/runtime/state/autostart.restart"
  unset YOISAKI_PROVISION_TOKEN
  find "$D" -xdev \\( ! -uid 1000 -o ! -gid 1000 \\) -exec chown -h 1000:1000 {} + 2>/dev/null
  if docker container inspect yoisaki-engine >/dev/null 2>&1; then
    docker start yoisaki-engine >>"$LOG" 2>&1
  else
    for attempt in 1 2 3; do docker pull "$YOISAKI_IMAGE_REF" >>"$LOG" 2>&1 && break; note "pull attempt $attempt failed"; sleep 30; done
    docker run -d --name yoisaki-engine --restart unless-stopped --gpus all --security-opt no-new-privileges:true --cap-drop ALL \\
      -v "$D:/data" "$YOISAKI_IMAGE_REF" >>"$LOG" 2>&1 || note 'docker run failed.'
  fi
else
  note 'Neither the YOISAKI image nor Docker is available on this instance: the engine was not started.'
fi
exit 0
`;
}

export function createBody({offer,disk_gb,name,image,token,max_price_hour_minor,currency}){
 if(!Number.isSafeInteger(offer?.id)||offer.id<1)fail('CC_INVALID_CREATE','Нет проверенного ID предложения.');
 if(!Number.isSafeInteger(disk_gb)||disk_gb<REQUIREMENTS.min_disk_gb||disk_gb>100000||offer.disk_gb!==null&&disk_gb>offer.disk_gb)fail('CC_INVALID_CREATE',`Размер диска: от ${REQUIREMENTS.min_disk_gb} ГБ${offer.disk_gb!==null?' до '+Math.floor(offer.disk_gb)+' ГБ (предел предложения)':''}.`);
 if(!Number.isSafeInteger(max_price_hour_minor)||max_price_hour_minor<1||!/^[A-Z]{3}$/.test(currency||''))fail('CC_INVALID_CREATE','Нет подтверждённой цены предложения.');
 if(typeof name!=='string'||!name.trim()||name.length>255||/[\x00-\x1f]/.test(name))fail('CC_INVALID_CREATE','Некорректное имя инстанса.');
 const body={ask_id:offer.id,auto_select:false,strict_offer:true,name,template_image:validateImage(image),disk_gb,max_price_hour_minor,currency,onstart:onstartScript({image,token})};
 if(offer.disk_gb!==null)body.offer_disk_space=offer.disk_gb;
 if(body.onstart.length>50000)fail('CC_INVALID_CREATE','Скрипт запуска слишком длинный.',500);
 return body;
}

// The create response has no documented schema: accept the usual places of a new instance ID.
export function createdInstanceId(json){
 const found=pick(json,['id','instance_id','data.id','data.instance_id','instance.id','data.instance.id','new_contract','result.id']);
 const value=found&&['string','number'].includes(typeof found.value)?String(found.value):'';
 return INSTANCE_ID.test(value)?value:null;
}

// Anonymous pull check for ghcr.io images: CloudCompute can only use an image it can download without credentials.
export async function checkImage(image,http){
 validateImage(image);
 const m=image.match(/^ghcr\.io\/([a-z0-9._\/-]+?)(?::([A-Za-z0-9._-]+)|@(sha256:[a-f0-9]{64}))?$/);
 if(!m)return {image,checked:false,accessible:null,message:'Доступность образа вне ghcr.io не проверяется автоматически.'};
 const repo=m[1],ref=m[2]||m[3]||'latest';
 try{
  const t=await http(`https://ghcr.io/token?scope=repository:${repo}:pull&service=ghcr.io`,{headers:{Accept:'application/json'}});
  const token=typeof t.json?.token==='string'?t.json.token:'';
  if(t.status!==200||!token)return {image,checked:true,accessible:false,message:`Реестр не выдал анонимный доступ (HTTP ${t.status}): образ не опубликован или пакет не публичный.`};
  const r=await http(`https://ghcr.io/v2/${repo}/manifests/${ref}`,{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json'}});
  if(r.status===200)return {image,checked:true,accessible:true,message:'Образ опубликован и доступен для скачивания без авторизации.'};
  return {image,checked:true,accessible:false,message:r.status===404?'Образ с этой версией не найден в реестре (ещё не опубликован).':`Реестр ответил HTTP ${r.status}: образ недоступен без авторизации (сделайте пакет публичным).`};
 }catch(e){return {image,checked:false,accessible:null,message:'Не удалось проверить реестр образов: '+publicError(e).error}}
}

export const newToken=()=>randomBytes(32).toString('hex');
export const instanceName=()=>'YOISAKI-'+randomBytes(3).toString('hex').toUpperCase();

// Public view of the stored deployment: never the token.
export function deploymentView(d,{watching=false}={}){
 if(!d)return null;
 return {instance_id:d.instance_id,name:d.name,image:d.image,created_at:d.created_at,adopted:!!d.adopted,offer:d.offer||null,disk_gb:d.disk_gb??null,auto_sync:!!d.auto_sync,
  stage:d.stage,stage_message:d.stage_message||'',stage_at:d.stage_at||null,error:d.error||'',instance_status:d.instance_status||'',url_found:!!d.url,url_host:d.url?new URL(d.url).hostname:'',
  gpu_stages:Array.isArray(d.gpu_stages)?d.gpu_stages:[],drive:d.drive||null,watching};
}

const STAGE_TEXT={
 CREATING:'Создаю GPU-сервер в CloudCompute…',
 GPU_CREATED:'GPU-сервер создан. Оплата идёт с этого момента.',
 INSTANCE_INITIALIZING:'CloudCompute запускает инстанс и скачивает образ YOISAKI ENGINE (первый раз 10–25 минут).',
 DOCKER_IMAGE_READY:'Образ запущен на GPU: автозапуск движка получил токен.',
 ENGINE_STARTING:'Движок запускается: проверка GPU/CUDA и загрузка сервера.',
 ENGINE_HEALTH_CHECK:'Найден защищённый адрес движка. Проверяю токен и состояние…',
 GPU_READY:'GPU готов к генерации.',
};
const GPU_STAGE_TO_DEPLOY={IMAGE_READY:'DOCKER_IMAGE_READY',ENGINE_STARTING:'ENGINE_STARTING',SERVER_READY:'ENGINE_STARTING',TUNNEL_RETRY:'ENGINE_STARTING'};
const rank=s=>DEPLOY_STAGES.indexOf(s);

// Follows one deployment until GPU_READY (or a timeout). Everything it reports was observed: the instance status from
// the CloudCompute API and stages/addresses signed with the engine token. Restartable ("Initialize engine").
export class DeploymentWatcher{
 constructor({secrets,cloud,progress,connect,connectionState,afterReady,sleep=ms=>new Promise(r=>setTimeout(r,ms).unref?.()),now=()=>Date.now(),interval=10000,timeoutMinutes=60}){
  Object.assign(this,{secrets,cloud,progress,connect,connectionState,afterReady,sleep,now,interval,timeoutMinutes});this.generation=0;this.running=false;this.connectingTo='';
 }
 get(){return this.secrets.deployment()}
 view(){return deploymentView(this.get(),{watching:this.running})}
 async update(patch){const before=this.get();if(!before)return null;await this.secrets.change(d=>{if(d.deployment&&d.deployment.instance_id===before.instance_id)Object.assign(d.deployment,patch)});return this.get()}
 async setStage(stage,message,extra={}){const d=this.get();if(!d)return;if(d.stage===stage&&(message??STAGE_TEXT[stage]??'')===d.stage_message&&!Object.keys(extra).some(k=>JSON.stringify(d[k])!==JSON.stringify(extra[k])))return;await this.update({stage,stage_message:message??STAGE_TEXT[stage]??'',stage_at:this.now(),...extra})}
 stop(){this.generation++;this.running=false}
 start(){const d=this.get();if(!d)fail('CC_NO_DEPLOYMENT','Сначала создайте GPU-сервер YOISAKI.',409);this.stop();const gen=this.generation;this.running=true;this.connectingTo='';this.startedAt=this.now();this.loop(gen).catch(()=>{}).finally(()=>{if(gen===this.generation)this.running=false});return this.view()}
 async loop(gen){
  const alive=()=>gen===this.generation;
  if(END_STAGES.includes(this.get()?.stage))await this.setStage('GPU_CREATED',undefined,{error:''});
  while(alive()){
   const d=this.get();if(!d)return;
   await this.tick(d,alive);
   if(!alive())return;
   const now=this.get();if(!now||now.stage==='GPU_READY'||END_STAGES.includes(now.stage))return;
   await this.sleep(this.interval);
  }
 }
 async tick(d,alive){
  let status='';
  try{const raw=await this.cloud.detail(d.instance_id);if(!alive())return;status=instanceView(raw?.data||raw?.instance||raw).status}
  catch(e){if(!alive())return;if(e.code==='CC_HTTP_404'){await this.setStage('INSTANCE_GONE','CloudCompute не находит этот инстанс: он удалён. Создайте новый GPU-сервер.');return}
   await this.update({error:'CloudCompute: '+publicError(e).error})}
  let p=null;try{p=await this.progress(d.token)}catch(e){if(!alive())return;await this.update({error:'Сервис обнаружения адреса недоступен: '+publicError(e).error})}
  if(!alive())return;
  const extra={instance_status:status||d.instance_status||''};
  if(p){extra.gpu_stages=p.stages.slice(-8);if(p.url)extra.url=p.url}
  let stage=rank(d.stage)>=rank('GPU_CREATED')?d.stage:'GPU_CREATED';
  if(status&&rank(stage)<rank('INSTANCE_INITIALIZING'))stage='INSTANCE_INITIALIZING';
  let message;
  const last=p?.stages?.at(-1);
  for(const s of p?.stages||[]){const mapped=GPU_STAGE_TO_DEPLOY[s.stage];if(mapped&&rank(mapped)>rank(stage))stage=mapped}
  if(last?.stage==='GPU_CHECK_FAILED')message='GPU не прошёл проверку CUDA/PyTorch: движок не запущен, чтобы не тратить время. Удалите инстанс и выберите другое предложение (драйвер с CUDA 12.8+).';
  else if(last?.stage==='ENGINE_FAILED')message='Движок завершился с ошибкой; автозапуск повторит попытку. Журнал: панель CloudCompute → логи инстанса.';
  else if(last?.stage==='TUNNEL_RETRY')message='Движок работает, защищённый туннель переподключается.';
  if(/^(exited|stopped|offline|inactive)$/i.test(status))message='CloudCompute сообщает: инстанс остановлен ('+status+'). Запустите его в панели CloudCompute.';
  const url=p?.url||d.url;
  if(url){
   if(rank(stage)<rank('ENGINE_HEALTH_CHECK'))stage='ENGINE_HEALTH_CHECK';
   const c=this.connectionState();
   if(c.phase==='READY'&&(c.origin===url||c.token===d.token)){await this.setStage('GPU_READY',undefined,{...extra,error:''});if(alive()&&this.afterReady)this.afterReady().catch(()=>{});return}
   if(this.connectingTo!==url&&!['CONNECTING','AUTHENTICATING','LOADING','STARTING'].includes(c.phase)){
    this.connectingTo=url;
    try{const r=await this.connect(url,d.token,{automatic:true});if(r?.message)message=r.message}catch(e){message='Подключение: '+publicError(e).error}
   }
  }
  if(rank(stage)<rank('ENGINE_HEALTH_CHECK')&&this.now()-Math.max(d.created_at,this.startedAt||0)>this.timeoutMinutes*60000){
   await this.setStage('TIMEOUT',`За ${this.timeoutMinutes} минут движок не сообщил о запуске. Проверьте логи инстанса в панели CloudCompute (onstart: /var/log/yoisaki-onstart.log). Оплата инстанса продолжается, пока он существует.`,extra);return;
  }
  await this.setStage(stage,message,{...extra,...(p?{error:''}:{})});
 }
}
