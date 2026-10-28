import {randomBytes} from 'node:crypto';
import {fail,publicError} from './errors.mjs';
import {instanceView} from './cloudcompute-api.mjs';
import {gpuAssessment} from './gpu-catalog.mjs';

// v1.7.5 zero-terminal CloudCompute deployment: GPU offers → paid instance with the prebuilt YOISAKI ENGINE image →
// automatic engine start (onstart) → signed stages and address (rendezvous) → engine connection → Drive models.
// Only documented CloudCompute fields are sent (docs/api/cloudcompute-openapi-2026-10-27.yaml: GET /offers,
// POST /instances with ask_id, strict_offer, template_image, disk_gb, offer_disk_space, max_price_hour_minor,
// currency, onstart). The OpenAPI file describes no success response schemas, so every response is parsed
// defensively: an unknown shape is an explicit error, never a guess presented as fact.

export const ENGINE_IMAGE='ghcr.io/regmop4576-hash/yoisaki-ai-studio/engine:1.7.5';
// Known deployment images: the engine protocol stays 1.7.0 in all of them (engine/ is unchanged).
export const IMAGE_NOTES={
 'ghcr.io/regmop4576-hash/yoisaki-ai-studio/engine:1.7.5':'Образ 1.7.5 запускается от uid 1000 и отклоняет RTX 4090/Ada (sm_89) при проверке GPU; исправлено в 1.7.7.',
};
export const IMAGE_RE=/^([a-z0-9][a-z0-9._\/-]*)(?::[@a-zA-Z0-9][@a-zA-Z0-9._-]*|@sha256:[a-fA-F0-9]{64})?$/;
// SDXL / Illustrious XL with ControlNet and Multi-LoRA: 12 GB is the practical minimum, 16 GB+ recommended.
// torch 2.10 cu128 wheels need a host driver that supports CUDA 12.8.
export const REQUIREMENTS={min_vram_mb:12288,recommended_vram_mb:16384,min_cuda:12.8,min_disk_gb:40,default_disk_gb:80,image_size_note_gb:13};
// v1.7.7 verified stages, in order. Each one is entered only on evidence: the app's own request (CREATING), the
// CloudCompute API (GPU_CREATED … INSTANCE_RUNNING, classified by classifyProvider()), a stage signed with the engine
// token by the GPU (DOCKER_IMAGE_READY, ENGINE_STARTING) or this app's health check over the tunnel (ENGINE_HEALTH_CHECK,
// GPU_READY). "CloudCompute instance running" (INSTANCE_RUNNING) is NOT "YOISAKI ENGINE ready" (GPU_READY).
// INSTANCE_INITIALIZING is the ambiguous 1.7.5/1.7.6 stage: stored records are read as PROVIDER_BOOTSTRAPPING.
export const DEPLOY_STAGES=['CREATING','GPU_CREATED','PROVIDER_BOOTSTRAPPING','IMAGE_PREPARING','INSTANCE_RUNNING','DOCKER_IMAGE_READY','ENGINE_STARTING','ENGINE_HEALTH_CHECK','GPU_READY'];
export const LEGACY_STAGES={INSTANCE_INITIALIZING:'PROVIDER_BOOTSTRAPPING'};
export const END_STAGES=['FAILED','TIMEOUT','INSTANCE_GONE'];
// v1.7.7 documented bootstrap profiles of POST /instances (OpenAPI enum). 'worker' is the default for the YOISAKI image:
// the image brings its own supervisor (CMD) and needs no SSH/Jupyter; a small provider bootstrap also leaves the most
// room in the combined bootstrap + onstart limit. 'provider_default' sends no field (the 1.7.5/1.7.6 behaviour).
// Not verified on a real instance yet: see YOISAKI_DOCKER_AUDIT.md.
export const BOOTSTRAP_PROFILES=['worker','access_only','full','none','provider_default'];
export const DEFAULT_BOOTSTRAP_PROFILE='worker';
// The OpenAPI snapshot limits `onstart` to 50 000 characters; the current documentation (as reported for this task,
// not reachable from the build environment) limits the COMBINED provider bootstrap + custom script to 16 384 bytes.
// The stricter rule is enforced in bytes, and the YOISAKI script keeps half of it for the provider's bootstrap.
export const ONSTART_LIMIT_BYTES=16384,ONSTART_BUDGET_BYTES=8192;
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
 const unavailable=o.rentable===false||o.rented===true||o.available===false||o.is_available===false||o.occupied===true;
 const reasons=[],warnings=[];
 if(unavailable)reasons.push('Предложение уже занято.');
 if(vram===null)warnings.push('VRAM не указан в ответе API.');else if(vram<REQUIREMENTS.min_vram_mb)reasons.push(`VRAM ${Math.round(vram/1024)} ГБ: для SDXL нужно не меньше 12 ГБ.`);else if(vram<REQUIREMENTS.recommended_vram_mb)warnings.push('12–16 ГБ VRAM: ControlNet и несколько LoRA могут работать медленнее.');
 if(cuda!==null&&cuda<REQUIREMENTS.min_cuda)reasons.push(`Драйвер поддерживает CUDA ${cuda}; образу нужна CUDA 12.8+.`);
 if(disk!==null&&disk<REQUIREMENTS.min_disk_gb)reasons.push(`Диск до ${Math.floor(disk)} ГБ: нужно не меньше ${REQUIREMENTS.min_disk_gb} ГБ.`);
 if(!price)reasons.push('Цена не указана в ответе API.');else if(!price.verified)reasons.push('Цена получена, но её единицы не подтверждены документацией: используйте «Расширенные настройки».');
 if(gpus>1)warnings.push(`${gpus} GPU в предложении: движок использует один, оплачиваются все.`);
 if(cuda===null)warnings.push('Версия CUDA драйвера не указана в ответе API: образу нужна CUDA 12.8+ (иначе NVIDIA Container Toolkit не запустит контейнер).');
 const gpu=text(pick(o,['gpu_name','gpu.name','gpu_model','gpu','model'])?.value)||'GPU';
 // v1.7.7: reference data only adds warnings (unusual VRAM, unknown model) and documented kernel gaps (e.g. Pascal).
 const assessed=gpuAssessment({gpu,gpus,vram_mb:vram});reasons.push(...assessed.reasons);warnings.push(...assessed.warnings);
 return {id,gpu,gpus,vram_mb:vram,vram_field:vramField,price,storage,disk_gb:disk,cuda,reliability,model:assessed.model,unavailable,
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

// The CloudCompute "onstart" script. It contains this instance's engine token: the provider stores it with the instance
// like any other instance setting; this app never logs it.
// v1.7.7:
//  - everything runs in a subshell and nothing calls `exit` at top level, so a provider that concatenates its own
//    bootstrap with this script (one combined script) can neither be ended early nor inherit shell options from it;
//  - the automatic (create) script only provisions the YOISAKI image. It never starts Docker itself: nested Docker is
//    not documented by CloudCompute, and the 1.7.5/1.7.6 "Docker host" branch could only run in a container that is
//    not the requested image. The manual command for an existing instance (adopt) keeps that branch, but only after
//    `docker info` proves a reachable daemon;
//  - the size is checked in bytes (ONSTART_BUDGET_BYTES of the ONSTART_LIMIT_BYTES combined limit).
export function onstartScript({image,token,docker=false}){
 validateImage(image);validateToken(token);
 const dockerBranch=docker?`
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  note "Docker daemon reachable: starting $YOISAKI_IMAGE_REF in it."
  D=\${YOISAKI_HOST_DATA:-/workspace/yoisaki-data}
  [ -d "$(dirname "$D")" ] || D=/var/lib/yoisaki-data
  mkdir -p "$D/config/engine" "$D/runtime/state" && chmod 700 "$D/config/engine"
  printf '%s\\n' "$YOISAKI_PROVISION_TOKEN" >"$D/config/engine/engine.token" && chmod 600 "$D/config/engine/engine.token"
  printf '%s\\n' '{"version": 1, "stable_link": true, "rendezvous": "ntfy"}' >"$D/config/engine/autostart.json"
  touch "$D/runtime/state/autostart.restart"
  unset YOISAKI_PROVISION_TOKEN
  find "$D" -xdev \\( ! -uid 1000 -o ! -gid 1000 \\) -exec chown -h 1000:1000 {} + 2>/dev/null
  if docker container inspect yoisaki-engine >/dev/null 2>&1; then
    docker start yoisaki-engine >>"$LOG" 2>&1 || note 'docker start yoisaki-engine failed.'
  else
    for attempt in 1 2 3; do docker pull "$YOISAKI_IMAGE_REF" >>"$LOG" 2>&1 && break; note "pull attempt $attempt failed"; sleep 30; done
    docker run -d --name yoisaki-engine --restart unless-stopped --gpus all --security-opt no-new-privileges:true --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --cap-add FOWNER \\
      -v "$D:/data" "$YOISAKI_IMAGE_REF" >>"$LOG" 2>&1 || note 'docker run failed.'
  fi
elif command -v docker >/dev/null 2>&1; then
  note 'docker CLI found, but no reachable Docker daemon: nested Docker is not available here. The engine was not started.'`:'';
 return `#!/bin/bash
# YOISAKI AI STUDIO 1.7.7 · YOISAKI ENGINE initialization for this instance (generated; contains this instance's
# engine token, do not share). Log: /var/log/yoisaki-onstart.log or /tmp/yoisaki-onstart.log
(
umask 077
YOISAKI_IMAGE_REF=${quote(image)}
YOISAKI_PROVISION_TOKEN=${quote(token)}
export YOISAKI_PROVISION_TOKEN
APP=\${YOISAKI_APP_DIR:-/opt/yoisaki}
LOG=/var/log/yoisaki-onstart.log
{ touch "$LOG"; } 2>/dev/null || LOG=/tmp/yoisaki-onstart.log
note() { printf '%s %s\\n' "$(date '+%F %T')" "$*" >>"$LOG" 2>/dev/null; }
note "onstart: uid $(id -u), requested image $YOISAKI_IMAGE_REF"
if [ -x "$APP/cloudcompute/autostart-image.sh" ]; then
  note 'YOISAKI image detected: provisioning the engine.'
  "$APP/cloudcompute/autostart-image.sh" --provision >>"$LOG" 2>&1 || note "autostart-image.sh --provision failed (code $?)."${dockerBranch}
else
  note "YOISAKI ENGINE image not found in this container ($APP/cloudcompute/autostart-image.sh missing): it does not run the requested image. The engine was not started."
fi
) </dev/null
true
`;
}
export const bytes=text=>Buffer.byteLength(text,'utf8');

export function createBody({offer,disk_gb,name,image,token,max_price_hour_minor,currency,bootstrap_profile=DEFAULT_BOOTSTRAP_PROFILE}){
 if(!Number.isSafeInteger(offer?.id)||offer.id<1)fail('CC_INVALID_CREATE','Нет проверенного ID предложения.');
 if(!Number.isSafeInteger(disk_gb)||disk_gb<REQUIREMENTS.min_disk_gb||disk_gb>100000||offer.disk_gb!==null&&disk_gb>offer.disk_gb)fail('CC_INVALID_CREATE',`Размер диска: от ${REQUIREMENTS.min_disk_gb} ГБ${offer.disk_gb!==null?' до '+Math.floor(offer.disk_gb)+' ГБ (предел предложения)':''}.`);
 if(!Number.isSafeInteger(max_price_hour_minor)||max_price_hour_minor<1||!/^[A-Z]{3}$/.test(currency||''))fail('CC_INVALID_CREATE','Нет подтверждённой цены предложения.');
 if(typeof name!=='string'||!name.trim()||name.length>255||/[\x00-\x1f]/.test(name))fail('CC_INVALID_CREATE','Некорректное имя инстанса.');
 if(!BOOTSTRAP_PROFILES.includes(bootstrap_profile))fail('CC_INVALID_CREATE','Неизвестный профиль инициализации CloudCompute.');
 const body={ask_id:offer.id,auto_select:false,strict_offer:true,name,template_image:validateImage(image),disk_gb,max_price_hour_minor,currency,onstart:onstartScript({image,token})};
 if(offer.disk_gb!==null)body.offer_disk_space=offer.disk_gb;
 if(bootstrap_profile!=='provider_default')body.bootstrap_profile=bootstrap_profile;
 if(bytes(body.onstart)>ONSTART_BUDGET_BYTES||body.onstart.length>50000)fail('CC_INVALID_CREATE',`Скрипт запуска ${bytes(body.onstart)} байт: больше бюджета ${ONSTART_BUDGET_BYTES} из ${ONSTART_LIMIT_BYTES} байт общего лимита CloudCompute.`,500);
 return body;
}

// The create response has no documented schema: accept the usual places of a new instance ID.
export function createdInstanceId(json){
 const found=pick(json,['id','instance_id','data.id','data.instance_id','instance.id','data.instance.id','new_contract','result.id']);
 const value=found&&['string','number'].includes(typeof found.value)?String(found.value):'';
 return INSTANCE_ID.test(value)?value:null;
}

// v1.7.7: what a refused creation means. The provider's text is not documented, so the classification is by HTTP status
// and keywords; the provider's own message is always shown verbatim next to it.
const TAKEN=/\b(taken|occupied|rented|unavailable|not available|no longer available|already (?:rented|in use|taken)|busy|ineligible|sold out|host is (?:full|busy))\b|занят|недоступ|уже арендован/i;
const BALANCE=/balance|insufficient|funds|top.?up|payment required|недостаточно средств|баланс|пополн/i;
export function classifyCreateError(e){
 const status=e?.http_status||Number(String(e?.code||'').replace('CC_HTTP_',''))||0,text=[e?.provider_message,e?.provider_code].filter(Boolean).join(' ');
 if(status===402||BALANCE.test(text))return 'INSUFFICIENT_BALANCE';
 if(status===409||(status===422||status===400||status===404)&&TAKEN.test(text)||/offer_(?:taken|unavailable|not_available)|host_(?:busy|occupied)/i.test(e?.provider_code||''))return 'OFFER_TAKEN';
 if(status===429)return 'RATE_LIMITED';
 if(status===401||status===403)return 'AUTH';
 if(status>=400&&status<500)return 'REJECTED';
 return 'UNKNOWN_OUTCOME';
}

// v1.7.7 provider status → phase. CloudCompute documents no status vocabulary: these are common names; anything else is
// UNKNOWN and never counts as progress. intended_status (what the user asked for) is never taken as evidence.
const RX={GONE:/^(deleted|destroyed|terminated|terminating|removed|deleting|destroying)$/i,FAILED:/^(error|errored|failed|failure|crashed|dead|unhealthy|create_failed|start_failed)$/i,
 STOPPED:/^(exited|stopped|stopping|offline|inactive|paused|suspended|shutdown|shut_down)$/i,RUNNING:/^(running|active|started|online|ready)$/i,
 IMAGE:/^(loading|pulling|downloading|image_pull|image_pulling|pulling_image|extracting)$/i,BOOT:/^(starting|booting|initializing|initialising|bootstrapping|configuring|setup|installing|provisioning)$/i,
 CREATE:/^(created|creating|new|pending|queued|scheduling|scheduled|allocating|allocated|waiting|reserved)$/i};
export const DOCKER_ERROR=/failed to solve|no such container|error response from daemon|pull access denied|manifest unknown|manifest for \S+ not found|no space left on device|toomanyrequests|unauthorized: authentication required|oci runtime|nvidia-container-cli|unsatisfied condition: cuda|exec format error/i;
const GPU_HOST_ERROR=/nvidia-container-cli|unsatisfied condition: cuda|cuda driver version is insufficient|no cuda-capable device/i;
export function classifyProvider(view){
 const f=view?.provider||{},states=[f.actual_status,f.status,f.state,f.cur_state].filter(Boolean);
 const message=[f.status_msg,f.status_message,f.message,f.error,f.error_message].filter(Boolean).join(' · ').slice(0,400);
 let phase='UNKNOWN';
 if(states.some(v=>RX.GONE.test(v)))phase='GONE';
 else if(states.some(v=>RX.FAILED.test(v)))phase='FAILED';
 else{const primary=states[0]||view?.status||'';for(const k of ['RUNNING','STOPPED','IMAGE','BOOT','CREATE'])if(RX[k].test(primary)){phase=k;break}}
 const docker=DOCKER_ERROR.test(message);
 return {phase,status:view?.status||'UNKNOWN',message,docker_error:docker,component:!docker?'cloudcompute':GPU_HOST_ERROR.test(message)?'gpu_host':'docker'};
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
  if(r.status===200){
   // v1.7.7: the platform is read from the manifest when the registry sends it (an index lists platforms; a single
   // manifest does not name one — its config blob is not fetched here, so the architecture then stays unverified).
   const platforms=Array.isArray(r.json?.manifests)?r.json.manifests.map(x=>x?.platform&&`${x.platform.os}/${x.platform.architecture}`).filter(Boolean):[];
   const amd64=platforms.length?platforms.includes('linux/amd64'):null;
   if(amd64===false)return {image,checked:true,accessible:false,platforms,message:'Образ опубликован, но без linux/amd64: на GPU-серверах CloudCompute он не запустится.'};
   return {image,checked:true,accessible:true,platforms,linux_amd64:amd64,message:'Образ опубликован и доступен для скачивания без авторизации.'+(IMAGE_NOTES[image]?' '+IMAGE_NOTES[image]:'')};
  }
  return {image,checked:true,accessible:false,message:r.status===404?'Образ с этой версией не найден в реестре (ещё не опубликован).':`Реестр ответил HTTP ${r.status}: образ недоступен без авторизации (сделайте пакет публичным).`};
 }catch(e){return {image,checked:false,accessible:null,message:'Не удалось проверить реестр образов: '+publicError(e).error}}
}

export const newToken=()=>randomBytes(32).toString('hex');
export const instanceName=()=>'YOISAKI-'+randomBytes(3).toString('hex').toUpperCase();
export const normalizeStage=stage=>LEGACY_STAGES[stage]||stage;

// Public view of the stored deployment: never the token.
export function deploymentView(d,{watching=false}={}){
 if(!d)return null;
 const stage=normalizeStage(d.stage),provider=d.provider||null;
 return {instance_id:d.instance_id,name:d.name,image:d.image,created_at:d.created_at,adopted:!!d.adopted,offer:d.offer||null,disk_gb:d.disk_gb??null,auto_sync:!!d.auto_sync,
  stage,stage_message:d.stage_message||'',stage_at:d.stage_at||null,error:d.error||'',instance_status:d.instance_status||'',url_found:!!d.url,url_host:d.url?new URL(d.url).hostname:'',
  gpu_stages:Array.isArray(d.gpu_stages)?d.gpu_stages:[],drive:d.drive||null,watching,
  // v1.7.7: the two conditions the user must be able to tell apart, plus the evidence behind them.
  instance_running:provider?.phase==='RUNNING',engine_ready:stage==='GPU_READY',
  provider,failure:d.failure||null,stage_history:Array.isArray(d.stage_history)?d.stage_history:[],bootstrap_profile:d.bootstrap_profile||null,terminal:d.terminal||null,pending:String(d.instance_id).startsWith('pending-')};
}

const STAGE_TEXT={
 CREATING:'Создаю GPU-сервер в CloudCompute…',
 GPU_CREATED:'CloudCompute принял заказ: инстанс создан. Оплата идёт с этого момента.',
 PROVIDER_BOOTSTRAPPING:'CloudCompute выделяет GPU-хост и готовит инстанс (статус провайдера ниже).',
 IMAGE_PREPARING:'CloudCompute готовит образ YOISAKI ENGINE (≈4,6 ГБ; первый раз 10–25 минут).',
 INSTANCE_RUNNING:'CloudCompute сообщает: инстанс работает. YOISAKI ENGINE ещё не отозвался — ждём сигнала контейнера.',
 DOCKER_IMAGE_READY:'Контейнер YOISAKI запущен на GPU и получил токен движка.',
 ENGINE_STARTING:'Движок запускается: проверка GPU/CUDA и загрузка сервера.',
 ENGINE_HEALTH_CHECK:'Найден защищённый адрес движка. Проверяю токен и состояние…',
 GPU_READY:'YOISAKI ENGINE прошёл проверку состояния: GPU готов к генерации.',
};
const GPU_STAGE_TO_DEPLOY={IMAGE_READY:'DOCKER_IMAGE_READY',ENGINE_STARTING:'ENGINE_STARTING',SERVER_READY:'ENGINE_STARTING',TUNNEL_RETRY:'ENGINE_STARTING'};
const PROVIDER_TO_DEPLOY={CREATE:'GPU_CREATED',BOOT:'PROVIDER_BOOTSTRAPPING',IMAGE:'IMAGE_PREPARING',RUNNING:'INSTANCE_RUNNING'};
const PROGRESS_SIGNALS=['IMAGE_READY','ENGINE_STARTING','SERVER_READY','TUNNEL_RETRY'];
const rank=s=>DEPLOY_STAGES.indexOf(normalizeStage(s));
const HISTORY_MAX=40,QUIET_MINUTES=15;
const timeoutText=(stage,minutes,providerStatus,profile)=>{
 const tail=' Оплата инстанса продолжается, пока он существует: удалите его, если он не нужен.';
 if(rank(stage)<rank('INSTANCE_RUNNING'))return `За ${minutes} минут CloudCompute не сообщил, что инстанс работает (статус провайдера: ${providerStatus||'неизвестен'}). Сбой на стороне CloudCompute: выделение хоста, подготовка или скачивание образа.`+tail;
 if(rank(stage)===rank('INSTANCE_RUNNING'))return `CloudCompute сообщает «${providerStatus||'running'}», но контейнер YOISAKI за ${minutes} минут не прислал ни одного сигнала. Вероятно, onstart не выполнился или образ не стартовал (профиль инициализации: ${profile||'по умолчанию провайдера'}). Журнал: /var/log/yoisaki-onstart.log или /tmp/yoisaki-onstart.log.`+tail;
 return `Контейнер YOISAKI запущен, но движок за ${minutes} минут не прошёл запуск. Сбой внутри движка (Python/PyTorch/туннель): журнал /data/logs/server.log и /data/logs/autostart.log.`+tail;
};

// Follows one deployment until GPU_READY (or a timeout). Everything it reports was observed: the instance status from
// the CloudCompute API and stages/addresses signed with the engine token. Restartable ("Initialize engine").
export class DeploymentWatcher{
 constructor({secrets,cloud,progress,connect,connectionState,afterReady,sleep=ms=>new Promise(r=>setTimeout(r,ms).unref?.()),now=()=>Date.now(),interval=10000,timeoutMinutes=60}){
  Object.assign(this,{secrets,cloud,progress,connect,connectionState,afterReady,sleep,now,interval,timeoutMinutes});this.generation=0;this.running=false;this.connectingTo='';
 }
 get(){return this.secrets.deployment()}
 view(){return deploymentView(this.get(),{watching:this.running})}
 async update(patch){const before=this.get();if(!before)return null;await this.secrets.change(d=>{if(d.deployment&&d.deployment.instance_id===before.instance_id)Object.assign(d.deployment,patch)});return this.get()}
 // v1.7.7: every stage change is recorded with its time and evidence source; the original provider status is kept.
 async setStage(stage,message,extra={},source='app'){
  const d=this.get();if(!d)return;
  const text=message??STAGE_TEXT[stage]??'',changed=normalizeStage(d.stage)!==stage;
  if(!changed&&text===d.stage_message&&!Object.keys(extra).some(k=>JSON.stringify(d[k])!==JSON.stringify(extra[k])))return;
  const history=Array.isArray(d.stage_history)?d.stage_history:[];
  const patch={stage,stage_message:text,...extra};
  if(changed){patch.stage_at=this.now();patch.stage_history=[...history,{stage,at:patch.stage_at,source,provider_status:(extra.instance_status??d.instance_status)||''}].slice(-HISTORY_MAX)}
  await this.update(patch);
 }
 stop(){this.generation++;this.running=false}
 start(){const d=this.get();if(!d)fail('CC_NO_DEPLOYMENT','Сначала создайте GPU-сервер YOISAKI.',409);this.stop();const gen=this.generation;this.running=true;this.connectingTo='';this.startedAt=this.now();this.loop(gen).catch(()=>{}).finally(()=>{if(gen===this.generation)this.running=false});return this.view()}
 async loop(gen){
  const alive=()=>gen===this.generation;
  if(END_STAGES.includes(this.get()?.stage))await this.setStage('GPU_CREATED','Наблюдение перезапущено: проверяю инстанс заново.',{error:'',failure:null});
  while(alive()){
   const d=this.get();if(!d)return;
   await this.tick(d,alive);
   if(!alive())return;
   const now=this.get();if(!now||now.stage==='GPU_READY'||END_STAGES.includes(now.stage))return;
   await this.sleep(this.interval);
  }
 }
 async tick(d,alive){
  const now=this.now(),errors=[],extra={};let pc=null;
  try{
   const raw=await this.cloud.detail(d.instance_id);if(!alive())return;
   const view=instanceView(raw?.data||raw?.instance||raw);pc=classifyProvider(view);
   extra.instance_status=view.status;extra.provider={status:view.status,fields:view.provider,phase:pc.phase,message:pc.message,checked_at:now};
  }catch(e){
   if(!alive())return;
   if(e.code==='CC_HTTP_404'){await this.setStage('INSTANCE_GONE','CloudCompute не находит этот инстанс: он удалён. Создайте новый GPU-сервер.',{failure:null,provider:{...(d.provider||{}),phase:'GONE',checked_at:now}},'cloudcompute');return}
   errors.push('CloudCompute API: '+publicError(e).error);
  }
  let p=null;try{p=await this.progress(d.token)}catch(e){if(!alive())return;errors.push('Сервис обнаружения адреса недоступен: '+publicError(e).error)}
  if(!alive())return;
  if(p){extra.gpu_stages=p.stages.slice(-8);if(p.url)extra.url=p.url}
  extra.error=errors.join(' · ');
  if(pc?.phase==='GONE'){await this.setStage('INSTANCE_GONE',`CloudCompute сообщает: инстанс удалён (${pc.status}).`,{...extra,failure:null},'cloudcompute');return}
  if(pc?.phase==='FAILED'){
   const failure={component:pc.component,code:pc.component==='cloudcompute'?'PROVIDER_FAILED':pc.component==='gpu_host'?'GPU_HOST_FAILED':'DOCKER_FAILED',message:pc.message||pc.status,provider_status:pc.status,terminal:true,at:now};
   const who={cloudcompute:'CloudCompute',docker:'Docker на хосте CloudCompute',gpu_host:'драйвер/NVIDIA Container Toolkit на хосте CloudCompute'}[pc.component];
   await this.setStage('FAILED',`Сбой: ${who} (статус «${pc.status}»)${pc.message?': '+pc.message:''}. Движок YOISAKI до запуска не дошёл. Удалите инстанс и выберите другое предложение.`,{...extra,failure},'cloudcompute');return;
  }
  let stage=rank(d.stage)>=rank('GPU_CREATED')?normalizeStage(d.stage):'GPU_CREATED',source='app';
  const fromProvider=PROVIDER_TO_DEPLOY[pc?.phase];
  if(fromProvider&&rank(fromProvider)>rank(stage)){stage=fromProvider;source='cloudcompute'}
  const signals=p?.stages||[],last=signals.at(-1);
  for(const s of signals){const mapped=GPU_STAGE_TO_DEPLOY[s.stage];if(mapped&&rank(mapped)>rank(stage)){stage=mapped;source='engine'}}
  // Failures are derived from the CURRENT observations every tick: a verified recovery clears an old error by itself.
  let message,failure=null;
  if(last?.stage==='GPU_CHECK_FAILED'){failure={component:'gpu',code:'GPU_CHECK_FAILED',message:'GPU не прошёл проверку CUDA/PyTorch',terminal:true,at:now};message='GPU не прошёл проверку CUDA/PyTorch: движок не запущен, чтобы не тратить время. Удалите инстанс и выберите другое предложение (драйвер с CUDA 12.8+, архитектура из списка совместимых).'}
  else if(last?.stage==='ENGINE_FAILED'){failure={component:'engine',code:'ENGINE_FAILED',message:'Python-процесс движка завершился с ошибкой',terminal:false,at:now};message='Движок (Python) завершился с ошибкой; автозапуск повторит попытку до 4 раз. Журнал: /data/logs/server.log.'}
  else if(last?.stage==='TUNNEL_RETRY')message='Движок работает, защищённый туннель Cloudflare переподключается.';
  if(pc?.phase==='STOPPED'){failure={component:'cloudcompute',code:'INSTANCE_STOPPED',message:'инстанс остановлен ('+pc.status+')',terminal:false,at:now};message='CloudCompute сообщает: инстанс остановлен ('+pc.status+'). Запустите его в панели CloudCompute.'}
  else if(pc?.docker_error&&!failure){failure={component:pc.component,code:pc.component==='gpu_host'?'GPU_HOST_ERROR':'DOCKER_ERROR',message:pc.message,terminal:false,at:now};message=`CloudCompute сообщает об ошибке ${pc.component==='gpu_host'?'драйвера/NVIDIA Container Toolkit':'Docker'} (статус «${pc.status}»): ${pc.message}`}
  if(d.adopted&&rank(stage)<=rank('INSTANCE_RUNNING')&&!message&&!signals.length)message='Инстанс '+(pc?.phase==='RUNNING'?'работает':'ещё запускается')+'. Выполните показанную команду один раз в веб-терминале инстанса (панель CloudCompute).';
  if(stage==='INSTANCE_RUNNING'&&!message){
   const since=(d.stage_history||[]).findLast?.(h=>h.stage==='INSTANCE_RUNNING')?.at||d.stage_at||now;
   if(normalizeStage(d.stage)==='INSTANCE_RUNNING'&&now-since>QUIET_MINUTES*60000)message=`CloudCompute сообщает «${pc?.status||d.instance_status}» уже ${Math.round((now-since)/60000)} мин, но контейнер YOISAKI не отозвался. Инстанс работает, движок — нет. Проверьте веб-терминал/журнал инстанса (/var/log/yoisaki-onstart.log); профиль инициализации: ${d.bootstrap_profile||'по умолчанию провайдера'}.`;
  }
  const url=p?.url||d.url;
  if(url){
   if(rank(stage)<rank('ENGINE_HEALTH_CHECK')){stage='ENGINE_HEALTH_CHECK';source='engine'}
   const c=this.connectionState();
   if(c.phase==='READY'&&(c.origin===url||c.token===d.token)){await this.setStage('GPU_READY',undefined,{...extra,failure:null},'health');if(alive()&&this.afterReady)this.afterReady().catch(()=>{});return}
   if(this.connectingTo!==url&&!['CONNECTING','AUTHENTICATING','LOADING','STARTING'].includes(c.phase)){
    this.connectingTo=url;
    try{const r=await this.connect(url,d.token,{automatic:true});if(r?.message&&!message)message=r.message}catch(e){failure=failure||{component:'connection',code:e.code||'CONNECT_FAILED',message:publicError(e).error,terminal:false,at:now};message='Подключение: '+publicError(e).error}
   }
  }
  if(!alive())return;
  if(rank(stage)<rank('ENGINE_HEALTH_CHECK')&&now-Math.max(d.created_at,this.startedAt||0)>this.timeoutMinutes*60000){
   await this.setStage('TIMEOUT',timeoutText(stage,this.timeoutMinutes,pc?.status||d.instance_status,d.bootstrap_profile),{...extra,failure:failure||{component:rank(stage)<rank('INSTANCE_RUNNING')?'cloudcompute':rank(stage)===rank('INSTANCE_RUNNING')?'bootstrap':'engine',code:'TIMEOUT',message:'нет сигнала за '+this.timeoutMinutes+' мин',terminal:true,at:now},last_verified_stage:stage},'app');return;
  }
  await this.setStage(stage,message,{...extra,failure},source);
 }
}
