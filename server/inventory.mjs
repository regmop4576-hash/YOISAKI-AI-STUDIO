import {fail} from './errors.mjs';
// v1.7.3 model inventory. The engine's /models answer is parsed entry by entry: one malformed entry is
// reported (models_rejected) instead of discarding the whole catalogue, and every model the engine marks
// incompatible or unknown carries a human reason, so nothing disappears silently from the generator.
// Heavy safetensors metadata never reaches state.json or the page: only the base-model hint is kept.
export const MODEL_KINDS=['checkpoint','lora','vae','controlnet'];
const text=(v,max)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):'';
function entryProblem(m){
 if(!m||typeof m!=='object')return 'запись не является объектом';
 if(typeof m.name!=='string'||!m.name||m.name.length>300)return 'нет корректного имени файла';
 if(!/^[a-f0-9]{32}$/.test(m.id))return 'неверный ID модели';
 if(!MODEL_KINDS.includes(m.kind))return 'неизвестный тип модели';
 if(typeof m.architecture!=='string')return 'не указана архитектура';
 if(!(m.compatible===null||typeof m.compatible==='boolean'))return 'неверный признак совместимости';
 if(!(m.size_bytes===null||Number.isFinite(m.size_bytes)&&m.size_bytes>=0))return 'неверный размер файла';
 return '';
}
// Mirrors engine/worker/models.py: inspect(); the base-model hint is what that function reads.
export function baseModelHint(m){
 if(typeof m?.base_model==='string')return text(m.base_model,120);
 const meta=m?.metadata&&typeof m.metadata==='object'?m.metadata:{};
 return [meta.ss_base_model_version,meta['modelspec.architecture']].map(v=>text(v,60)).filter(Boolean).join(' · ').slice(0,120);
}
export function compatibilityReason(m){
 const base=m.base_model?` («${m.base_model}»)`:'';
 if(m.compatible===false){
  if(m.architecture==='invalid')return 'Файл не читается как safetensors: повреждён, не докопирован или имеет другой формат. Сверьте размер и SHA-256 с исходным файлом и скопируйте его заново.'+(m.detail?` Движок: ${m.detail}`:'');
  if(m.kind==='lora')return `Метаданные LoRA указывают другую базовую модель${base}: SD 1.x/2.x, Flux или SD3. Генератор работает с LoRA для SDXL / Illustrious XL. Если LoRA обучена на SDXL, метаданные файла неверны.`;
  if(m.kind==='checkpoint')return 'В файле нет ключей SDXL (conditioner.embedders.1 и model.diffusion_model): это не SDXL / Illustrious XL checkpoint.';
  if(m.kind==='vae')return 'В файле нет ключей VAE (encoder/decoder).';
  return 'Движок пометил модель как несовместимую.';
 }
 if(m.compatible===null){
  if(m.kind==='lora')return 'Базовая модель не указана в метаданных: совместимость с SDXL не подтверждена, но LoRA можно использовать.';
  if(m.kind==='vae')return 'Структура VAE подходит; совместимость с SDXL по заголовку не проверяется.';
  return 'Совместимость не определена по заголовку файла.';
 }
 return '';
}
// Returns {models, rejected, tagSources}. Stored models are compact; tagSources feed LoRA trigger words once.
export function parseInventory(x){
 if(!x||!Array.isArray(x.models)||x.models.length>3000)fail('INVALID_RESPONSE','Некорректный список моделей от GPU.',502);
 const models=[],rejected=[],tagSources={},seen=new Set();
 for(const m of x.models){
  const problem=entryProblem(m)||(seen.has(m.id)?'повторяющийся ID модели':'');
  if(problem){rejected.push({name:text(m?.name,300)||'(без имени)',kind:MODEL_KINDS.includes(m?.kind)?m.kind:null,reason:problem});continue}
  seen.add(m.id);
  const item={id:m.id,name:m.name,kind:m.kind,architecture:text(m.architecture,80),compatible:m.compatible,size_bytes:m.size_bytes};
  if(typeof m.relative_path==='string'&&m.relative_path.length<=1000&&!m.relative_path.startsWith('/')&&!m.relative_path.split('/').some(p=>!p||p==='..'||p==='.')&&!/[\\\u0000-\u001f]/.test(m.relative_path))item.relative_path=m.relative_path;
  const base=baseModelHint(m);if(base)item.base_model=base;
  const detail=text(m.detail,300).replace(/[a-f0-9]{64}/g,'[СКРЫТО]').replace(/(?:\/[\w.-]+){2,}/g,'[путь]');if(detail)item.detail=detail;
  const reason=compatibilityReason(item);if(reason)item.compatibility_reason=reason;
  delete item.detail;
  models.push(item);
  if(m.kind==='lora')tagSources[m.id]={trigger_words:m.trigger_words,sidecar:m.sidecar&&typeof m.sidecar==='object'?{trainedWords:m.sidecar.trainedWords,description:m.sidecar.description}:undefined};
 }
 return {models,rejected:rejected.slice(0,50),tagSources,revision:typeof x.revision==='string'&&/^[a-f0-9]{16,64}$/.test(x.revision)?x.revision:null};
}
