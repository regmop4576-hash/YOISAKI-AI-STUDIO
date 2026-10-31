import fs from 'node:fs/promises';
import path from 'node:path';
import {AppError,fail,publicError} from './errors.mjs';
import {baseModelHint,compatibilityReason} from './inventory.mjs';
// v1.7.6 Google Drive model library: works on the phone with the stored OAuth token, without any GPU.
// Nothing here is invented: kinds come from the folder layout the engine scans (engine/worker/models.py KINDS),
// sync eligibility repeats cloudcompute/drive_sync.py classify() rule by rule, and architecture/compatibility
// come only from the real safetensors header (engine inspect() rules), read with HTTP Range requests: the phone
// never downloads model weights. Without a header read the architecture is reported as unknown.
export const ENGINE_FOLDERS={checkpoints:'checkpoint',loras:'lora',vae:'vae',controlnet:'controlnet'};
export const SYNC_FOLDERS={checkpoints:'checkpoint',loras:'lora',vae:'vae'};
export const SYNC_LIMITS={checkpoint:[256*2**20,32*2**30],lora:[16*2**10,4*2**30],vae:[2**20,2*2**30]};
export const SYNC_MAX_DEPTH=4,SYNC_MAX_FILES=2000,SYNC_RESERVE=2*2**30;
const PICKLE=['.ckpt','.pt','.pth','.bin','.pkl','.pickle'];
const MODEL_EXT=['.safetensors','.ckpt','.pt','.pth','.bin'];
// Python's \w is Unicode-aware: letters, digits and underscore of any script.
export const SEGMENT_RE=/^[\p{L}\p{N}_ .()+\-[\]]{1,120}$/u;
export const NAME_RE=/^[\p{L}\p{N}_ .()+\-[\]]{1,200}\.safetensors$/u;
export const HEADER_MAX=32*2**20;   // engine header(): larger headers are rejected as damaged
const FIRST_READ=64*1024;     // most LoRA/VAE headers fit; larger headers take one more exact request
const FOLDER_MIME='application/vnd.google-apps.folder',SHORTCUT_MIME='application/vnd.google-apps.shortcut';
const FIELDS='id,name,mimeType,size,modifiedTime,md5Checksum,sha1Checksum,sha256Checksum,headRevisionId,trashed,capabilities(canDownload),shortcutDetails(targetId,targetMimeType)';
const LIMITS={folders:500,entries:20000,items:3000,depth:8,pages:50,shortcuts:200};
const ID=/^[A-Za-z0-9_-]{1,200}$/;
const id=v=>{if(typeof v!=='string'||!ID.test(v))fail('DRIVE_INVALID_FOLDER','Некорректный ID Google Drive.');return v};

export function fmt(n){return n>=2**30?`${(n/2**30).toFixed(2)} ГБ`:n>=2**20?`${(n/2**20).toFixed(1)} МБ`:`${Math.round(n/2**10)} КБ`}
const extOf=name=>(name.toLowerCase().match(/\.[a-z0-9]+$/)||[''])[0];
export const isModelFile=(rel)=>{const parts=rel.split('/');const ext=extOf(parts.at(-1));return MODEL_EXT.includes(ext)};

// Mirrors drive_sync.classify(): returns {eligible, reason}. Order and wording of the checks are the same.
export function syncRule(rel,size){
 const parts=rel.split('/');const kind=SYNC_FOLDERS[parts[0]];
 if(!kind||parts.length<2)return {eligible:false,reason:parts[0]==='controlnet'&&parts.length>1?'ControlNet не входит в GPU-синхронизацию: движок 1.7.0 загружает ControlNet (OpenPose, Canny, Depth) из Hugging Face.':'GPU-синхронизация переносит только файлы из папок checkpoints/, loras/ и vae/ выбранной папки.'};
 const name=parts.at(-1),low=name.toLowerCase();
 if(rel.length>400||rel.includes('\\')||rel.includes('\u0000')||parts.length>SYNC_MAX_DEPTH||parts.some(p=>p==='.'||p==='..'||p.startsWith('.')||!SEGMENT_RE.test(p)))return {eligible:false,reason:'Небезопасное имя или путь (разрешены буквы, цифры, пробел и ._-()+[]; без скрытых папок; не глубже двух подпапок).'};
 if(PICKLE.some(e=>low.endsWith(e)))return {eligible:false,reason:'Формат pickle (.ckpt/.pt/.pth/.bin) не загружается: он может выполнять код. Используйте .safetensors.'};
 if(!low.endsWith('.safetensors'))return {eligible:false,reason:'Неподдерживаемый формат: движок принимает только .safetensors.'};
 if(!NAME_RE.test(name))return {eligible:false,reason:'Недопустимое имя файла.'};
 if(!Number.isSafeInteger(size)||size<0)return {eligible:false,reason:'Google Drive не сообщил размер файла.'};
 const [lo,hi]=SYNC_LIMITS[kind];
 if(size<lo||size>hi)return {eligible:false,reason:`Размер ${fmt(size)} вне допустимого для ${kind} (${fmt(lo)}–${fmt(hi)}).`};
 return {eligible:true,reason:''};
}
// What the engine catalogue does with the file (engine/worker/models.py entries()).
export function engineRule(rel){
 const parts=rel.split('/');const kind=parts.length>1?ENGINE_FOLDERS[parts[0]]:null;const ext=extOf(parts.at(-1));
 if(!kind)return {kind:'unknown',visible:false,reason:'Файл вне папок checkpoints/, loras/, vae/ и controlnet/: движок YOISAKI его не видит. Тип не определяется по расположению.'};
 if(ext!=='.safetensors')return {kind,visible:false,reason:PICKLE.includes(ext)?'Движок не загружает формат pickle (.ckpt/.pt/.pth/.bin): нужен .safetensors.':'Движок читает только .safetensors.'};
 if(kind==='controlnet')return {kind,visible:true,reason:'Файл попадёт в каталог движка, но генератор ControlNet 1.7.0 использует модели Hugging Face (OpenPose, Canny, Depth), а не файлы из controlnet/.'};
 return {kind,visible:true,reason:''};
}
export function classifyFile(rel,size){
 const ext=extOf(rel.split('/').at(-1));
 return {...engineRule(rel),format:ext==='.safetensors'?'safetensors':ext?ext.slice(1):'other',sync:syncRule(rel,size)};
}

// ---- safetensors header (engine inspect()/header() semantics, fetch_models.validate() payload check) -------------
const pyStr=v=>v===undefined?'':v===null?'None':v===true?'True':v===false?'False':String(v);
export function headerLength(prefix,size){
 if(prefix.length<8)throw new Error('Повреждён safetensors');
 const n=Number(prefix.readBigUInt64LE(0));
 if(n>HEADER_MAX||(Number.isFinite(size)&&n>size-8))throw new Error('Повреждён заголовок');
 return n;
}
export function parseHeader(bytes){
 let value;try{value=JSON.parse(bytes.toString('utf8'))}catch{throw new Error('Заголовок не является JSON')}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Неверный заголовок safetensors');
 const meta=Object.hasOwn(value,'__metadata__')?value.__metadata__:{};
 if(!meta||typeof meta!=='object'||Array.isArray(meta))throw new Error('Неверный заголовок safetensors');
 return value;
}
// Exactly the decision of engine/worker/models.py inspect(path, kind) for a file.
export function inspectHeader(header,kind){
 const meta=header.__metadata__||{};const keys=Object.keys(header);
 if(kind==='checkpoint'){const ok=keys.some(k=>k.includes('conditioner.embedders.1.'))&&keys.some(k=>k.includes('model.diffusion_model.'));return {architecture:ok?'SDXL':'unsupported',compatible:ok}}
 if(kind==='lora'){
  const hint=(pyStr(meta.ss_base_model_version)+' '+pyStr(meta['modelspec.architecture'])).toLowerCase();
  if(['sd_v1','sd_v2','flux','sd3'].some(x=>hint.includes(x)))return {architecture:'unsupported',compatible:false};
  const ok=hint.includes('xl')||keys.some(k=>k.includes('lora_te2_')||k.includes('text_encoder_2'));
  return {architecture:ok?'SDXL':'unknown',compatible:ok?true:null};
 }
 if(kind==='vae'){const ok=keys.some(k=>k.endsWith('decoder.conv_in.weight'))&&keys.some(k=>k.endsWith('encoder.conv_out.weight'));return {architecture:ok?'SDXL VAE candidate':'unsupported',compatible:ok?null:false}}
 return {architecture:'unknown',compatible:null};
}
// Only a hint for files outside the engine folders: says where the file would belong, never "compatible".
export function guessKind(header){
 const keys=Object.keys(header);
 if(keys.some(k=>k.includes('conditioner.embedders.1.'))&&keys.some(k=>k.includes('model.diffusion_model.')))return 'checkpoint';
 if(keys.some(k=>k.includes('controlnet_cond_embedding')||k.startsWith('control_model.')))return 'controlnet';
 if(keys.some(k=>/lora_(?:up|down|A|B)|\.lora\.|lora_te|lora_unet|\.alpha$/.test(k)))return 'lora';
 if(keys.some(k=>k.endsWith('decoder.conv_in.weight'))&&keys.some(k=>k.endsWith('encoder.conv_out.weight'))&&!keys.some(k=>k.includes('diffusion_model')))return 'vae';
 return null;
}
// fetch_models.validate(): the declared tensor data must end exactly at the end of the file.
export function payloadEnd(header){
 let end=0;
 for(const [k,v] of Object.entries(header)){if(k==='__metadata__')continue;const o=v&&typeof v==='object'?v.data_offsets:null;
  if(!Array.isArray(o)||o.length!==2||!o.every(Number.isSafeInteger)||o[0]<0||o[0]>o[1])throw new Error('Неверные границы данных тензора');end=Math.max(end,o[1])}
 return end;
}
export function headerReport(header,n,size,kind){
 const report={checked_at:Date.now(),header_bytes:n,architecture:'unknown',compatible:null,base_model:'',guess:null,payload:'UNKNOWN',reason:''};
 const base=baseModelHint({metadata:header.__metadata__});if(base)report.base_model=base;
 try{const end=payloadEnd(header);report.payload=Number.isFinite(size)?(8+n+end===size?'OK':'MISMATCH'):'UNKNOWN'}catch(e){report.payload='INVALID';report.reason=e.message}
 if(['checkpoint','lora','vae','controlnet'].includes(kind)){Object.assign(report,inspectHeader(header,kind));const why=compatibilityReason({kind,compatible:report.compatible,architecture:report.architecture,base_model:report.base_model});if(why&&kind!=='controlnet')report.reason=why}
 else{report.guess=guessKind(header);report.reason=report.guess?`По заголовку файл похож на ${report.guess}. Движок увидит его только в папке ${Object.keys(ENGINE_FOLDERS).find(f=>ENGINE_FOLDERS[f]===report.guess)}/.`:'Тип модели по заголовку не определён.'}
 if(report.payload==='MISMATCH')report.reason=(report.reason?report.reason+' ':'')+'Размер файла на Google Drive не совпадает с заголовком safetensors: файл повреждён или не докачан. Синхронизация отклонит его.';
 return report;
}

// ---- errors → explicit library states -----------------------------------------------------------------------------
export const LIBRARY_STATES=['VERIFIED','CACHED','NONE','NOT_CONNECTED','FOLDER_NOT_SELECTED','AUTH_EXPIRED','PERMISSION_DENIED','FOLDER_NOT_FOUND','OFFLINE','RATE_LIMITED','ERROR'];
export function libraryErrorState(e){
 const c=e?.code||'';
 if(c==='DRIVE_NOT_CONNECTED')return 'NOT_CONNECTED';
 if(c==='DRIVE_FOLDER_REQUIRED')return 'FOLDER_NOT_SELECTED';
 if(c==='DRIVE_REFRESH_FAILED'||c==='DRIVE_HTTP_401')return 'AUTH_EXPIRED';
 if(c==='DRIVE_SCOPE')return 'PERMISSION_DENIED';
 if(c==='DRIVE_HTTP_403'||c==='DRIVE_HTTP_429')return e.limited||c==='DRIVE_HTTP_429'?'RATE_LIMITED':'PERMISSION_DENIED';
 if(c==='DRIVE_HTTP_404'||c==='DRIVE_FOLDER_GONE')return 'FOLDER_NOT_FOUND';
 if(c==='PROVIDER_NETWORK'||c==='PROVIDER_REDIRECT')return 'OFFLINE';
 return 'ERROR';
}
const STATE_HINT={AUTH_EXPIRED:'Доступ Google истёк или отозван. Нажмите «Сменить Google-аккаунт» и войдите снова: папка останется выбранной.',PERMISSION_DENIED:'У подключённого аккаунта нет прав (область drive.readonly) на эту папку или файл. Проверьте, что папка ваша или открыта вам.',FOLDER_NOT_FOUND:'Выбранная папка не найдена: удалена, перемещена в корзину или доступ к ней закрыт. Выберите папку заново.',OFFLINE:'Нет связи с Google. Показан сохранённый список, он может быть устаревшим.',RATE_LIMITED:'Google временно ограничил запросы. Повторите через несколько минут.',NOT_CONNECTED:'Войдите в Google в блоке «Аккаунт и папка».',FOLDER_NOT_SELECTED:'Выберите папку моделей в блоке «Аккаунт и папка».'};
const queryText=q=>{if(q===undefined||q===null||q==='')return '';if(typeof q!=='string'||q.length>100||/[\u0000-\u001f]/.test(q))fail('DRIVE_INVALID_QUERY','Поиск: до 100 символов.');return q.trim()};
const relPath=p=>{if(p===undefined||p===null||p==='')return '';if(typeof p!=='string'||p.length>400||p.split('/').some(s=>!s||s==='.'||s==='..'||s.length>200||/[\u0000-\u001f\\]/.test(s)))fail('DRIVE_INVALID_PATH','Некорректный путь.');return p};
const best=f=>f.sha256Checksum?{type:'sha256',value:String(f.sha256Checksum).toLowerCase()}:f.sha1Checksum?{type:'sha1',value:String(f.sha1Checksum).toLowerCase()}:f.md5Checksum?{type:'md5',value:String(f.md5Checksum).toLowerCase()}:null;
const sizeOf=f=>f.size===undefined?null:Number.isSafeInteger(Number(f.size))?Number(f.size):null;
const sameRevision=(a,b)=>a&&b&&a.size===b.size&&a.modified===b.modified&&JSON.stringify(a.checksum)===JSON.stringify(b.checksum)&&a.revision===b.revision;

// The GPU sync rejects at install what the engine marks incompatible or a broken payload (fetch_models.validate):
// known from the header, such a file is not offered for a paid download.
export function headerRejects(item){const h=item?.header;if(!h)return '';if(h.compatible===false||h.payload==='MISMATCH'||h.payload==='INVALID')return h.reason||'Файл не пройдёт проверку движка.';return ''}
export class DriveLibrary{
 constructor({drive,dir,now=()=>Date.now()}){this.drive=drive;this.file=path.join(dir,'drive-library.json');this.now=now;this.data={version:1,inventory:null,last_check:null,selection:null};this.chain=Promise.resolve();this.checking=null}
 async init(){try{const raw=JSON.parse(await fs.readFile(this.file,'utf8'));if(raw?.version===1)this.data={version:1,inventory:raw.inventory||null,last_check:raw.last_check||null,selection:raw.selection||null}}catch(e){if(e.code!=='ENOENT')await fs.rename(this.file,this.file+'.damaged-'+Date.now()).catch(()=>{})}return this}
 save(){if(this.closed)return this.chain;const bytes=JSON.stringify(this.data);const task=this.chain.then(async()=>{const temp=this.file+'.tmp';const h=await fs.open(temp,'w',0o600);try{await h.writeFile(bytes);await h.sync()}finally{await h.close()}await fs.rename(temp,this.file)});this.chain=task.catch(()=>{});return task}
 account(){const d=this.drive.secrets.drive();return d?{connected:true,email:d.account?.email||'',folder:d.folder||null}:{connected:false,email:'',folder:null}}
 // Cached inventory is only ever labelled CACHED; VERIFIED is returned once, by the check that produced it.
 view(){
  const acc=this.account(),inv=this.data.inventory,sameFolder=!!inv&&!!acc.folder&&inv.folder?.id===acc.folder.id&&inv.account===acc.email;
  return {account:acc,state:sameFolder?'CACHED':'NONE',inventory:sameFolder?inv:null,other_folder_inventory:inv&&!sameFolder?{folder:inv.folder,verified_at:inv.verified_at}:null,last_check:this.data.last_check,checking:!!this.checking};
 }
 async browse({folder,page,query,path:rel,outside}={}){
  const acc=this.account();if(!acc.connected)fail('DRIVE_NOT_CONNECTED','Сначала войдите в Google.',409);
  const parent=id(folder||acc.folder?.id||'root');const q=queryText(query),base=outside?null:relPath(rel);
  if(typeof page!=='string'&&page!==undefined&&page!==null||page&&page.length>2048)fail('DRIVE_INVALID_PAGE','Некорректная страница.');
  const where=[`'${parent}' in parents`,'trashed = false'];if(q)where.push(`name contains '${q.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}'`);
  const params=new URLSearchParams({q:where.join(' and '),fields:`nextPageToken,files(${FIELDS})`,pageSize:'100',orderBy:'folder,name',supportsAllDrives:'true',includeItemsFromAllDrives:'true'});if(page)params.set('pageToken',page);
  const data=await this.drive.get('/files?'+params);if(!Array.isArray(data?.files))fail('DRIVE_INVALID_RESPONSE','Google вернул неверный список файлов.',502);
  const known=new Map((this.view().inventory?.items||[]).map(i=>[i.id,i]));
  const entries=data.files.filter(f=>ID.test(f.id||'')&&typeof f.name==='string').map(f=>{
   const isFolder=f.mimeType===FOLDER_MIME||f.mimeType===SHORTCUT_MIME&&f.shortcutDetails?.targetMimeType===FOLDER_MIME;
   const name=String(f.name).slice(0,300);
   if(isFolder)return {type:'folder',id:f.mimeType===SHORTCUT_MIME?f.shortcutDetails.targetId:f.id,name,shortcut:f.mimeType===SHORTCUT_MIME};
   const size=sizeOf(f),r=base===null?null:(base?base+'/':'')+name;
   const entry={type:'file',id:f.id,name,size,modified:f.modifiedTime||null,checksum:best(f),revision:f.headRevisionId||null,can_download:f.capabilities?.canDownload!==false,native:String(f.mimeType||'').startsWith('application/vnd.google-apps.'),shortcut:f.mimeType===SHORTCUT_MIME,model:isModelFile(name)};
   if(r)Object.assign(entry,{path:r,...classifyFile(r,size)});else if(entry.model)Object.assign(entry,{kind:'unknown',format:extOf(name).slice(1),visible:false,reason:'Вне выбранной папки моделей: тип не определяется.',sync:{eligible:false,reason:'Файл вне выбранной папки моделей.'}});
   const inv=known.get(f.id);if(inv?.header)entry.header=inv.header;
   return entry;
  });
  return {folder:parent,path:base,query:q,entries,next_page:data.nextPageToken||null};
 }
 async parent(folder){
  const f=await this.drive.get('/files/'+id(folder)+'?fields=id,name,parents&supportsAllDrives=true');
  const p=Array.isArray(f?.parents)&&ID.test(f.parents[0]||'')?f.parents[0]:null;if(!p)return {parent:null};
  const meta=await this.drive.get('/files/'+p+'?fields=id,name&supportsAllDrives=true');return {parent:{id:p,name:String(meta?.name||'Google Drive')}};
 }
 check(){if(!this.checking)this.checking=this.scan().finally(()=>{this.checking=null});return this.checking}
 async scan(){
  const started=this.now();let stage='AUTH';
  try{
   const acc=this.account();if(!acc.connected)fail('DRIVE_NOT_CONNECTED','Сначала войдите в Google.',409);if(!acc.folder)fail('DRIVE_FOLDER_REQUIRED','Выберите папку моделей.',409);
   const about=await this.drive.get('/about?fields=user(emailAddress)');if(!about?.user?.emailAddress)fail('DRIVE_INVALID_RESPONSE','Google не подтвердил аккаунт.',502);
   stage='FOLDER';
   const root=await this.drive.get('/files/'+id(acc.folder.id)+'?fields=id,name,mimeType,trashed&supportsAllDrives=true');
   if(root.trashed)fail('DRIVE_FOLDER_GONE','Выбранная папка находится в корзине Google Drive.',404);
   if(root.mimeType!==FOLDER_MIME)fail('DRIVE_FOLDER_GONE','Выбранный объект больше не является папкой.',404);
   stage='LIST';
   const previous=new Map((this.view().inventory?.items||[]).map(i=>[i.id,i]));
   const items=[],warnings=[],visited=new Set([root.id]),queue=[{id:root.id,rel:'',depth:0}];let folders=0,entries=0,other=0,syncRows=0,truncated=false,deeper=0,shortcuts=0,denied=0;
   while(queue.length){
    const f=queue.shift();folders++;if(folders>LIMITS.folders){truncated=true;warnings.push(`Просмотрено ${LIMITS.folders} папок; остальные не проверены. Разделите библиотеку.`);break}
    let page='';for(let n=0;n<LIMITS.pages;n++){
     const params=new URLSearchParams({q:`'${f.id}' in parents and trashed = false`,fields:`nextPageToken,files(${FIELDS})`,pageSize:'1000',supportsAllDrives:'true',includeItemsFromAllDrives:'true'});if(page)params.set('pageToken',page);
     const data=await this.drive.get('/files?'+params);if(!Array.isArray(data?.files))fail('DRIVE_INVALID_RESPONSE','Google вернул неверный список файлов.',502);
     for(let file of data.files){
      entries++;if(entries>LIMITS.entries){truncated=true;break}
      if(!ID.test(file?.id||'')||typeof file.name!=='string')continue;
      const name=file.name.slice(0,300),rel=(f.rel?f.rel+'/':'')+name,depth=f.depth+1;
      let shortcut=false;
      if(file.mimeType===SHORTCUT_MIME){
       const target=file.shortcutDetails?.targetId;if(!ID.test(target||''))continue;
       if(file.shortcutDetails.targetMimeType===FOLDER_MIME){if(!visited.has(target)&&depth<LIMITS.depth){visited.add(target);queue.push({id:target,rel,depth})}continue}
       if(++shortcuts>LIMITS.shortcuts){if(shortcuts===LIMITS.shortcuts+1)warnings.push('Слишком много ярлыков: часть ярлыков на файлы не проверена.');continue}
       try{file={...await this.drive.get('/files/'+target+'?fields='+FIELDS+'&supportsAllDrives=true'),name:file.name}}catch(e){if(e instanceof AppError&&/^DRIVE_HTTP_4/.test(e.code)){denied++;items.push({id:target,name,path:rel,folder:f.rel,size:null,modified:null,checksum:null,revision:null,can_download:false,shortcut:true,...classifyFile(rel,null),permission:'DENIED',permission_reason:'Ярлык указывает на файл, недоступный этому аккаунту: '+e.message});continue}throw e}
       shortcut=true;
      }
      if(file.mimeType===FOLDER_MIME){if(depth<LIMITS.depth&&!visited.has(file.id)){visited.add(file.id);queue.push({id:file.id,rel,depth})}else if(depth>=LIMITS.depth)deeper++;continue}
      if(String(file.mimeType||'').startsWith('application/vnd.google-apps.'))continue;   // Google Docs: rclone --drive-skip-gdocs
      if(depth<=SYNC_MAX_DEPTH)syncRows++;
      if(!isModelFile(name)){other++;continue}
      if(items.length>=LIMITS.items){truncated=true;continue}
      const size=sizeOf(file);
      const item={id:file.id,name,path:rel,folder:f.rel,size,modified:file.modifiedTime||null,checksum:best(file),revision:file.headRevisionId||null,can_download:file.capabilities?.canDownload!==false,shortcut,...classifyFile(rel,size)};
      if(!item.can_download){denied++;item.permission='DENIED';item.permission_reason='Владелец файла запретил скачивание для этого аккаунта: GPU не сможет его загрузить.'}
      const old=previous.get(item.id);if(old?.header&&sameRevision(old,item))item.header=old.header;
      items.push(item);
     }
     page=data.nextPageToken||'';if(!page||truncated)break;
    }
    if(truncated)break;
   }
   if(deeper)warnings.push(`Пропущено вложенных папок глубже ${LIMITS.depth} уровней: ${deeper}.`);
   if(syncRows>SYNC_MAX_FILES)warnings.push(`В папке ${syncRows} файлов (до 4 уровней): GPU-синхронизация откажется работать (предел ${SYNC_MAX_FILES}). Разделите библиотеку или уберите лишние файлы.`);
   if(denied)warnings.push(`Нет прав на скачивание: ${denied} файл(ов). Они отмечены в списке.`);
   items.sort((a,b)=>a.path.localeCompare(b.path));
   const inventory={folder:{id:root.id,name:String(root.name)},account:acc.email,verified_at:this.now(),duration_ms:this.now()-started,items,folders_scanned:folders,non_model_files:other,sync_rows:syncRows,truncated,warnings};
   this.data.inventory=inventory;this.data.last_check={at:this.now(),ok:true,state:'VERIFIED',code:'',message:`Проверено онлайн: ${items.length} файлов моделей.`};await this.save();
   return {...this.view(),state:'VERIFIED',verified_now:true};
  }catch(e){
   let state=libraryErrorState(e);if(stage==='FOLDER'&&e.code==='DRIVE_HTTP_404')state='FOLDER_NOT_FOUND';
   const message=publicError(e).error+(STATE_HINT[state]?' '+STATE_HINT[state]:'');
   this.data.last_check={at:this.now(),ok:false,state,code:e.code||'LOCAL_ERROR',message};await this.save();
   return {...this.view(),verified_now:false,error:{state,code:e.code||'LOCAL_ERROR',message}};
  }
 }
 // Reads only the safetensors header of inventory files (Range requests); the result is cached per Drive revision.
 async inspect(ids){
  if(!Array.isArray(ids)||!ids.length||ids.length>20||ids.some(x=>typeof x!=='string'||!ID.test(x)))fail('DRIVE_INVALID_SELECTION','Выберите от 1 до 20 файлов.');
  const inv=this.view().inventory;if(!inv)fail('DRIVE_CHECK_REQUIRED','Сначала нажмите «Проверить Google Drive».',409);
  const results=[];
  for(const fileId of new Set(ids)){
   const item=inv.items.find(i=>i.id===fileId);if(!item){results.push({id:fileId,ok:false,error:'Файла нет в последней проверке Google Drive.'});continue}
   if(item.format!=='safetensors'){results.push({id:fileId,ok:false,error:'Заголовок читается только у .safetensors.'});continue}
   if(item.can_download===false){results.push({id:fileId,ok:false,error:item.permission_reason||'Нет прав на скачивание.'});continue}
   try{
    let first=await this.drive.media(fileId,0,Math.min(FIRST_READ,(item.size??FIRST_READ)||1)-1);
    const n=headerLength(first,item.size??undefined);
    const rest=8+n>first.length?await this.drive.media(fileId,first.length,8+n-1):Buffer.alloc(0);
    const raw=Buffer.concat([first,rest]);if(raw.length<8+n)throw new Error('Google вернул неполный заголовок.');
    item.header=headerReport(parseHeader(raw.subarray(8,8+n)),n,item.size,item.kind);results.push({id:fileId,ok:true,header:item.header});
   }catch(e){
    if(e instanceof AppError){const state=libraryErrorState(e);results.push({id:fileId,ok:false,state,error:publicError(e).error});if(['AUTH_EXPIRED','OFFLINE','RATE_LIMITED'].includes(state))break;continue}
    item.header={checked_at:this.now(),architecture:'invalid',compatible:false,payload:'INVALID',reason:'Файл не читается как safetensors: '+e.message+' Синхронизация отклонит его.',header_bytes:null,base_model:'',guess:null};results.push({id:fileId,ok:true,header:item.header});
   }
  }
  await this.save();return {results,inventory:this.view().inventory};
 }
 // ---- selection for the next synchronization (independent of any GPU) ----------------------------------------
 selection(){const s=this.data.selection,acc=this.account();return s&&acc.folder&&s.folder_id===acc.folder.id?s:null}
 async select(paths){
  if(!Array.isArray(paths)||paths.length>SYNC_MAX_FILES||paths.some(p=>typeof p!=='string'||!p||p.length>400))fail('DRIVE_INVALID_SELECTION','Неверный выбор моделей.');
  const acc=this.account();if(!acc.folder)fail('DRIVE_FOLDER_REQUIRED','Выберите папку моделей.',409);
  const inv=this.view().inventory;const known=new Map((inv?.items||[]).map(i=>[i.path,i]));const old=this.selection()?.items||{};const items={},bad=[];
  for(const p of new Set(paths)){
   const i=known.get(p);
   if(i){const rejected=headerRejects(i);if(!i.sync.eligible||i.can_download===false||rejected){bad.push(`${i.name}: ${i.can_download===false?i.permission_reason:!i.sync.eligible?i.sync.reason:rejected}`);continue}items[p]={id:i.id,name:i.name,kind:i.kind,size:i.size}}
   else if(old[p])items[p]=old[p];   // kept from an earlier check (e.g. the list is not loaded right now)
   else bad.push(`${p}: нет в последней проверке Google Drive`);
  }
  if(bad.length)fail('DRIVE_INVALID_SELECTION','Эти файлы нельзя синхронизировать: '+bad.slice(0,5).join('; ')+(bad.length>5?` и ещё ${bad.length-5}`:''),422);
  this.data.selection={folder_id:acc.folder.id,folder_name:acc.folder.name,items,updated_at:this.now()};await this.save();return this.data.selection;
 }
}

// Estimated download and GPU disk need of the saved selection. `gpuItems` are the last items the GPU sync reported
// (INSTALLED files are not downloaded again); `disk` is the GPU's free space when known.
export function selectionEstimate(selection,inventory,{gpuItems=null,disk=null,plannedDiskGb=null,imageGb=13}={}){
 const entries=Object.entries(selection?.items||{});const byPath=new Map((inventory?.items||[]).map(i=>[i.path,i]));const gpu=new Map((gpuItems||[]).map(i=>[i.path,i]));
 let total=0,toDownload=0,installed=0,unknown=0,missingOnDrive=0;const files=[];
 for(const [p,saved] of entries){
  const i=byPath.get(p),size=i?.size??saved.size??0,g=gpu.get(p);total+=size;
  if(inventory&&!i)missingOnDrive++;
  const state=g?g.state:null;if(state==='INSTALLED')installed++;else{toDownload+=size;if(!g)unknown++}
  files.push({path:p,name:i?.name||saved.name,kind:i?.kind||saved.kind,size,gpu_state:state,on_drive:inventory?!!i:null});
 }
 const required=toDownload?toDownload+SYNC_RESERVE:0;
 const out={count:entries.length,total_bytes:total,download_bytes:toDownload,installed_on_gpu:installed,gpu_state_unknown:unknown,missing_on_drive:missingOnDrive,gpu_disk_required_bytes:required,reserve_bytes:SYNC_RESERVE,files,disk_check:'UNKNOWN',disk_message:''};
 if(disk&&Number.isFinite(disk.free_bytes)){out.disk_free_bytes=disk.free_bytes;out.disk_check=required<=disk.free_bytes?'OK':'INSUFFICIENT';out.disk_message=out.disk_check==='OK'?`На диске GPU свободно ${fmt(disk.free_bytes)}: места хватает.`:`На диске GPU свободно ${fmt(disk.free_bytes)}, а нужно ${fmt(required)} (с резервом ${fmt(SYNC_RESERVE)}). Синхронизация откажется начинать загрузку.`}
 else if(plannedDiskGb){const usable=(plannedDiskGb-imageGb)*2**30;out.planned_disk_gb=plannedDiskGb;out.disk_check=required<=usable?'PLANNED_OK':'PLANNED_INSUFFICIENT';out.disk_message=out.disk_check==='PLANNED_OK'?`Плановый диск GPU ${plannedDiskGb} ГБ: после образа движка (~${imageGb} ГБ) места хватает.`:`Плановый диск GPU ${plannedDiskGb} ГБ мал: образ ~${imageGb} ГБ + модели ${fmt(required)}. Выберите диск больше при создании сервера.`}
 return out;
}

// Synchronization tab: Google Drive inventory vs. what the GPU reported (sync items and the engine catalogue).
// Cloud availability and GPU availability are never merged: every row says where the information comes from.
export const COMPARE_CATEGORIES=['DRIVE_ONLY','INSTALLED','UPDATE','DOWNLOADING','FAILED','NOT_SYNCABLE'];
export function compareSources({inventory,gpuItems,gpuModels,currentPath=null,selection=null}){
 const gpu=new Map((gpuItems||[]).map(i=>[i.path,i]));const models=gpuModels||[];const chosen=new Set(Object.keys(selection?.items||{}));const matched=new Set();
 const rows=(inventory?.items||[]).map(i=>{
  const g=gpu.get(i.path),m=models.find(x=>x.kind===i.kind&&(x.relative_path?x.relative_path===i.path&&x.size_bytes===i.size:x.name===i.name));if(m)matched.add(m.id);
  let category,reason='';
  if(currentPath===i.path||g&&['DOWNLOADING','VERIFYING'].includes(g.state))category='DOWNLOADING';
  else if(g&&['FAILED','CONFLICT','REJECTED'].includes(g.state)){category='FAILED';reason=g.reason}
  else if(g?.state==='CHANGED'){category='UPDATE';reason=g.reason||'Файл на Google Drive изменился.'}
  else if(g?.state==='INSTALLED'||!g&&m)category='INSTALLED';
  else if(!i.sync.eligible||i.can_download===false||headerRejects(i)){category='NOT_SYNCABLE';reason=i.can_download===false?i.permission_reason:!i.sync.eligible?i.sync.reason:headerRejects(i)}
  else category='DRIVE_ONLY';
  return {path:i.path,name:i.name,kind:i.kind,size:i.size,selected:chosen.has(i.path),category,reason,gpu_state:g?.state||null,gpu_model:m?{id:m.id,compatible:m.compatible,architecture:m.architecture,reason:m.compatibility_reason||''}:null};
 });
 const gpu_only=models.filter(m=>!matched.has(m.id)).map(m=>({id:m.id,name:m.name,kind:m.kind,compatible:m.compatible,reason:m.compatibility_reason||''}));
 const counts=Object.fromEntries(COMPARE_CATEGORIES.map(c=>[c,rows.filter(r=>r.category===c).length]));
 return {rows,gpu_only,counts};
}
