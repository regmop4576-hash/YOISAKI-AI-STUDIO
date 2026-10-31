'use client';
import {useCallback,useEffect,useMemo,useState} from 'react';
import {Cloud,Folder,FolderUp,RefreshCw,Search,ScanSearch} from 'lucide-react';
import {useLibrary,bytesText,type DriveItem,type CompareRow,type LibraryState} from '@/lib/model-library';
import {useDirect} from '@/lib/engine/direct';
import {useStudio} from '@/stores/studio';
import {localApi} from '@/lib/local-api';

// v1.7.6 · Google Drive model library. Works with the phone's stored Google sign-in only: no GPU, SSH or Termux.
// Lists come from Google Drive; type/architecture only from the folder layout and the real safetensors header.
const KIND_LABEL:Record<string,string>={checkpoint:'Checkpoint',lora:'LoRA',vae:'VAE',controlnet:'ControlNet',unknown:'Unknown'};
const FILTERS:[string,string|null][]=[['ВСЕ',null],['CHECKPOINTS','checkpoint'],['LORA','lora'],['VAE','vae'],['CONTROLNET','controlnet'],['ДРУГОЕ','unknown']];
const PAGE=40;
type BrowseEntry=(DriveItem&{type:'file';model:boolean;native:boolean})|{type:'folder';id:string;name:string;shortcut:boolean};
type Crumb={id:string;name:string;path:string|null};
export function useT(){const en=useStudio(s=>s.language)==='English';return {en,t:(r:string,e:string)=>en?e:r}}

export function archText(i:Pick<DriveItem,'header'|'kind'|'format'>,t:(r:string,e:string)=>string){
 const h=i.header;
 if(i.format!=='safetensors')return t('формат не поддерживается движком','format not supported by the engine');
 if(!h)return t('архитектура не проверена','architecture not checked');
 if(h.architecture==='invalid')return t('файл повреждён','damaged file');
 if(h.architecture==='unsupported')return t('несовместима','incompatible');
 if(h.architecture==='unknown')return h.guess?t(`похоже на ${KIND_LABEL[h.guess]}`,`looks like ${KIND_LABEL[h.guess]}`):'Unknown';
 return h.architecture;
}
const gpuChip=(row:CompareRow|undefined,known:boolean,t:(r:string,e:string)=>string):[string,string]=>{
 if(!row)return ['',''];
 switch(row.category){case 'INSTALLED':return ['ok',t('✓ Установлена на GPU','✓ Installed on GPU')];case 'UPDATE':return ['warn',t('↻ На GPU старая версия','↻ Outdated on GPU')];case 'DOWNLOADING':return ['warn',t('⇣ Загружается на GPU','⇣ Downloading to GPU')];case 'FAILED':return ['bad',t('✕ Ошибка на GPU','✕ Failed on GPU')];case 'NOT_SYNCABLE':return ['bad',t('Не синхронизируется','Not synchronizable')];
  default:return known?['idle',t('Нет на GPU','Not on GPU')]:['idle',t('GPU: нет данных','GPU: no data')]}
};
export function ModelCard({item,row,gpuKnown,selected,onToggle,onInspect,busy}:{item:DriveItem;row?:CompareRow;gpuKnown:boolean;selected:boolean;onToggle?:()=>void;onInspect?:()=>void;busy:boolean}){
 const {en,t}=useT();const [tone,chip]=gpuChip(row,gpuKnown,t);
 const rejected=item.header&&(item.header.compatible===false||['MISMATCH','INVALID'].includes(item.header.payload));
 const selectable=item.sync.eligible&&item.can_download&&!rejected;
 const reasons=[item.permission_reason,!item.sync.eligible?item.sync.reason:'',item.reason,item.header?.reason,row?.category==='FAILED'||row?.category==='UPDATE'?row.reason:''].filter((x,i,a):x is string=>!!x&&a.indexOf(x)===i);
 return <article className={'card lib-item'+(selected?' picked':'')} data-kind={item.kind} data-path={item.path}>
  <div className="lib-item-head">
   {onToggle&&<input type="checkbox" aria-label={t('Выбрать ','Select ')+item.name} checked={selected} disabled={busy||!selectable&&!selected} onChange={onToggle}/>}
   <div className="grow"><b className="lib-name">{item.name}</b><div className="tiny muted">{bytesText(item.size)} · {KIND_LABEL[item.kind]} · {archText(item,t)}{item.header?.base_model?` · ${item.header.base_model}`:''}</div></div>
  </div>
  <div className="lib-meta tiny muted">
   <span>{t('Папка','Folder')}: {item.folder?'/'+item.folder:t('корень','root')}</span>
   <span>{t('Изменён','Modified')}: {item.modified?new Date(item.modified).toLocaleString(en?'en-GB':'ru-RU'):'—'}</span>
   <span>{item.checksum?`${item.checksum.type}: ${item.checksum.value.slice(0,12)}…`:t('контрольная сумма: нет','checksum: none')}{item.revision?` · rev ${item.revision.slice(0,10)}`:''}</span>
  </div>
  <div className="row tiny">
   <span className={'lib-chip '+(item.can_download?'ok':'bad')}>{item.can_download?t('☁️ Доступна на Google Drive','☁️ Available on Google Drive'):t('⛔ Нет прав на скачивание','⛔ Download not permitted')}</span>
   {chip&&<span className={'lib-chip '+tone}>{chip}</span>}
   {item.header&&<span className={'lib-chip '+(item.header.compatible===true?'ok':item.header.compatible===false?'bad':'idle')}>{item.header.compatible===true?t('Совместима (заголовок)','Compatible (header)'):item.header.compatible===false?t('Несовместима','Incompatible'):t('Совместимость не подтверждена','Compatibility unconfirmed')}</span>}
   {onInspect&&item.format==='safetensors'&&!item.header&&item.can_download&&<button className="pill" disabled={busy} onClick={onInspect}><ScanSearch size={13}/>{t('Определить тип','Detect type')}</button>}
  </div>
  {reasons.map(r=><p key={r} className={'tiny '+(rejected||!item.can_download?'danger':'muted')} style={{margin:0}}>{r}</p>)}
 </article>;
}

const STATE_TEXT:Record<LibraryState,[string,string,string]>={VERIFIED:['Проверено онлайн','Verified online','ok'],CACHED:['Сохранённый список','Cached inventory','idle'],NONE:['Ещё не проверялось','Not checked yet','idle'],NOT_CONNECTED:['Google не подключён','Google not connected','bad'],FOLDER_NOT_SELECTED:['Папка не выбрана','No folder selected','bad'],AUTH_EXPIRED:['Доступ истёк','Authorization expired','bad'],PERMISSION_DENIED:['Нет прав доступа','Permission denied','bad'],FOLDER_NOT_FOUND:['Папка не найдена','Folder not found','bad'],OFFLINE:['Нет связи','Offline','bad'],RATE_LIMITED:['Лимит Google','Google rate limit','bad'],ERROR:['Ошибка','Error','bad']};

export function DriveLibrary(){
 const {en,t}=useT();
 const lib=useLibrary(s=>s.library),busy=useLibrary(s=>s.busy),error=useLibrary(s=>s.error),{loadLibrary,check,inspect,select}=useLibrary.getState();
 const gpuConnected=useDirect(x=>!!x.url&&['READY','BUSY','LOADING'].includes(x.state));
 const [filter,setFilter]=useState<string|null>(null),[query,setQuery]=useState(''),[shown,setShown]=useState(PAGE),[mode,setMode]=useState<'list'|'folders'>('list');
 useEffect(()=>{void loadLibrary()},[loadLibrary]);
 useEffect(()=>{setShown(PAGE)},[filter,query]);
 const inv=lib?.inventory||null;const rows=useMemo(()=>new Map((lib?.comparison.rows||[]).map(r=>[r.path,r])),[lib]);
 const selected=useMemo(()=>new Set(Object.keys(lib?.selection?.items||{})),[lib]);
 const gpuKnown=!!lib?.gpu.sync_observed_at;
 const items=useMemo(()=>(inv?.items||[]).filter(i=>(!filter||i.kind===filter)&&(!query||i.path.toLowerCase().includes(query.toLowerCase()))),[inv,filter,query]);
 const selectable=(i:DriveItem)=>i.sync.eligible&&i.can_download&&!(i.header&&(i.header.compatible===false||['MISMATCH','INVALID'].includes(i.header.payload)));
 const toggle=(p:string)=>{const next=new Set(selected);if(next.has(p))next.delete(p);else next.add(p);void select([...next])};
 const unknownHeaders=items.filter(i=>i.format==='safetensors'&&!i.header&&i.can_download).map(i=>i.id);
 const est=lib?.estimate;const state:LibraryState=lib?.error?.state||lib?.state||'NONE';const [stateRu,stateEn,stateTone]=STATE_TEXT[lib?.verified_now?'VERIFIED':state];
 const checkedAt=lib?.verified_now?inv?.verified_at:lib?.inventory?.verified_at;
 return <section className="panel stack" aria-label="GOOGLE DRIVE — MODEL LIBRARY" data-localized="true">
  <div className="row" style={{justifyContent:'space-between'}}><h2 style={{margin:0}}><Cloud size={18} style={{verticalAlign:'-3px'}}/> {t('GOOGLE DRIVE — БИБЛИОТЕКА МОДЕЛЕЙ','GOOGLE DRIVE — MODEL LIBRARY')}</h2>
   <span className={'lib-badge '+stateTone} role="status" data-testid="library-state">{en?stateEn:stateRu}</span></div>
  <dl className="lib-indicators compact">
   <div data-tone={lib?.account.connected?'ok':'bad'}><dt>{t('Аккаунт','Account')}</dt><dd>{lib?.account.connected?t('Подключён','Connected'):t('Не подключён','Not connected')}</dd></div>
   <div data-tone={gpuConnected?'ok':'idle'}><dt>GPU</dt><dd>{gpuConnected?t('Онлайн','Online'):t('Офлайн — для просмотра Drive не нужен','Offline — not needed to browse Drive')}</dd></div>
   {!lib?.account.folder&&<div data-tone="bad"><dt>{t('Папка моделей','Model folder')}</dt><dd>{t('не выбрана','not selected')}</dd></div>}
   <div data-tone={stateTone}><dt>{t('Список','Inventory')}</dt><dd>{checkedAt?(lib?.verified_now?t('проверен онлайн ','verified online '):t('сохранён ','cached ')) +new Date(checkedAt).toLocaleString(en?'en-GB':'ru-RU'):t('не загружен','not loaded')}</dd></div>
  </dl>
  {lib?.error&&<p className="notice dangernotice" role="alert" style={{margin:0}}>{lib.error.message}{inv?t(' Ниже — сохранённый список, он не подтверждён.',' Below is the cached list; it is not verified.'):''}</p>}
  {!lib?.error&&lib?.state==='CACHED'&&!lib.verified_now&&<p className="tiny muted" style={{margin:0}}>{t('Показан сохранённый список. Нажмите «Проверить Google Drive», чтобы подтвердить его онлайн.','Showing the cached list. Press “Check Google Drive” to verify it online.')}</p>}
  {lib?.other_folder_inventory&&!inv&&<p className="tiny muted" style={{margin:0}}>{t('Сохранённый список относится к другой папке («'+lib.other_folder_inventory.folder.name+'») и не показывается.','The cached list belongs to another folder (“'+lib.other_folder_inventory.folder.name+'”) and is hidden.')}</p>}
  <div className="row">
   <button className="primary" disabled={!!busy||!lib?.account.connected||!lib.account.folder} onClick={()=>void check()}><RefreshCw size={15}/>{busy==='check'?t('Проверяю Google Drive…','Checking Google Drive…'):t('ПРОВЕРИТЬ GOOGLE DRIVE','CHECK GOOGLE DRIVE')}</button>
   {inv&&<button disabled={!!busy||!unknownHeaders.length} onClick={()=>void inspect(unknownHeaders.slice(0,100))}><ScanSearch size={15}/>{t(`Определить типы (${Math.min(unknownHeaders.length,100)})`,`Detect types (${Math.min(unknownHeaders.length,100)})`)}</button>}
   <div className="row" role="tablist" aria-label={t('Вид','View')}><button role="tab" aria-selected={mode==='list'} className={'pill '+(mode==='list'?'selected':'')} onClick={()=>setMode('list')}>{t('Все модели','All models')}</button><button role="tab" aria-selected={mode==='folders'} className={'pill '+(mode==='folders'?'selected':'')} disabled={!lib?.account.connected} onClick={()=>setMode('folders')}>{t('По папкам','Folders')}</button></div>
  </div>
  {busy==='check'&&<progress className="syncbar" aria-label={t('Чтение списка Google Drive','Reading Google Drive')}/>}
  {busy==='inspect'&&<p className="tiny muted" role="status" style={{margin:0}}>{t('Читаю только заголовки safetensors (килобайты, не веса модели)…','Reading safetensors headers only (kilobytes, not weights)…')}</p>}
  {error&&<p className="notice dangernotice" role="alert" style={{margin:0}}>{error}</p>}
  {inv?.warnings.map(w=><p key={w} className="notice" style={{margin:0}}>{w}</p>)}
  <SelectionBar/>
  {mode==='list'?<>
   <div className="row" role="tablist" aria-label={t('Тип модели','Model type')}>{FILTERS.map(([label,kind])=><button key={label} role="tab" aria-selected={filter===kind} className={'pill '+(filter===kind?'selected':'')} onClick={()=>setFilter(kind)}>{label==='ВСЕ'?t('ВСЕ','ALL'):label==='ДРУГОЕ'?t('ДРУГОЕ','OTHER'):label}{inv?` ${(inv.items.filter(i=>!kind||i.kind===kind)).length}`:''}</button>)}</div>
   <div className="row"><Search size={16} aria-hidden="true"/><input className="grow" value={query} onChange={e=>setQuery(e.target.value)} placeholder={t('Поиск по имени или папке','Search by name or folder')} aria-label={t('Поиск по Google Drive','Search Google Drive')}/></div>
   {inv&&<div className="row">
    <button disabled={!!busy||!items.some(selectable)} onClick={()=>void select([...new Set([...selected,...items.filter(selectable).map(i=>i.path)])])}>{t('Выбрать все','Select all')}{filter||query?t(' (видимые)',' (visible)'):''}</button>
    <button disabled={!!busy||!selected.size} onClick={()=>void select([])}>{t('Снять выбор','Deselect all')}</button>
   </div>}
   {!inv&&lib&&<div className="empty-models"><Cloud size={34}/><p>{lib.account.connected?t('Нажмите «Проверить Google Drive», чтобы получить список файлов из выбранной папки.','Press “Check Google Drive” to list the files of the selected folder.'):t('Войдите в Google в блоке «Аккаунт и папка» выше.','Sign in with Google in the “Account & folder” block above.')}</p></div>}
   {inv&&!inv.items.length&&<p className="notice" style={{margin:0}}>{t('В выбранной папке нет файлов моделей (.safetensors, .ckpt, .pt, .pth). Ожидаемая структура: checkpoints/, loras/, vae/, controlnet/.','No model files (.safetensors, .ckpt, .pt, .pth) in the selected folder. Expected layout: checkpoints/, loras/, vae/, controlnet/.')}</p>}
   {inv&&inv.items.length>0&&!items.length&&<p className="tiny muted">{t('Ничего не найдено.','Nothing found.')}</p>}
   <div className="stack lib-list">{items.slice(0,shown).map(i=><ModelCard key={i.id+i.path} item={i} row={rows.get(i.path)} gpuKnown={gpuKnown} selected={selected.has(i.path)} busy={!!busy} onToggle={()=>toggle(i.path)} onInspect={()=>void inspect([i.id])}/>)}</div>
   {items.length>shown&&<button onClick={()=>setShown(shown+PAGE)}>{t(`Показать ещё (${items.length-shown})`,`Show more (${items.length-shown})`)}</button>}
  </>:<FolderBrowser rows={rows} gpuKnown={gpuKnown} selected={selected} onToggle={toggle}/>}
 </section>;
}

export function SelectionBar(){
 const {t}=useT();const lib=useLibrary(s=>s.library);const est=lib?.estimate;if(!lib||!est)return null;
 const tone=est.disk_check==='INSUFFICIENT'||est.disk_check==='PLANNED_INSUFFICIENT'?'bad':'ok';
 return <div className="card stack lib-selection" aria-label={t('Выбор моделей','Model selection')} style={{gap:6}}>
  <b>{t('ВЫБОР ДЛЯ СИНХРОНИЗАЦИИ','SELECTED FOR SYNCHRONIZATION')}: {est.count}</b>
  {est.count>0?<>
   <span className="tiny">{t('Всего выбрано','Selected total')}: <b>{bytesText(est.total_bytes)}</b> · {t('скачать на GPU','to download')}: <b>{bytesText(est.download_bytes)}</b>{est.installed_on_gpu?` · ${t('уже на GPU','already on GPU')}: ${est.installed_on_gpu}`:''}</span>
   <span className="tiny">{t('Нужно места на диске GPU','GPU disk needed')}: <b>{bytesText(est.gpu_disk_required_bytes)}</b> {t(`(включая резерв ${bytesText(est.reserve_bytes)})`,`(incl. ${bytesText(est.reserve_bytes)} reserve)`)}</span>
   {est.disk_message&&<span className={'tiny '+(tone==='bad'?'danger':'muted')} role={tone==='bad'?'alert':undefined}>{est.disk_message}</span>}
   {est.missing_on_drive>0&&<span className="tiny danger">{t(`${est.missing_on_drive} выбранных файлов нет в последней проверке Google Drive.`,`${est.missing_on_drive} selected files are missing from the last Google Drive check.`)}</span>}
   {est.gpu_state_unknown>0&&<span className="tiny muted">{t('Для части файлов состояние на GPU неизвестно: оценка считает их как подлежащие загрузке. Уже установленные GPU не скачивает повторно.','The GPU state of some files is unknown: the estimate counts them as downloads. The GPU never re-downloads installed files.')}</span>}
  </>:<span className="tiny muted">{t('Ничего не выбрано. Отметьте модели — выбор сохранится на телефоне и будет использован, когда GPU станет доступен. Вся коллекция автоматически не скачивается.','Nothing selected. Tick models — the selection is saved on this phone and used when a GPU becomes available. The whole collection is never downloaded automatically.')}</span>}
 </div>;
}

function FolderBrowser({rows,gpuKnown,selected,onToggle}:{rows:Map<string,CompareRow>;gpuKnown:boolean;selected:Set<string>;onToggle:(p:string)=>void}){
 const {t}=useT();const lib=useLibrary(s=>s.library),busy=useLibrary(s=>s.busy),inspect=useLibrary(s=>s.inspect);
 const root=lib?.account.folder;const [trail,setTrail]=useState<Crumb[]>(()=>root?[{id:root.id,name:root.name,path:''}]:[]);
 const [entries,setEntries]=useState<BrowseEntry[]>([]),[next,setNext]=useState<string|null>(null),[q,setQ]=useState(''),[loading,setLoading]=useState(false),[err,setErr]=useState(''),[onlyModels,setOnlyModels]=useState(true),[above,setAbove]=useState<Crumb[]>([]);
 const here=trail[trail.length-1];const invById=useMemo(()=>new Map((lib?.inventory?.items||[]).map(i=>[i.id,i])),[lib]);
 const load=useCallback(async(crumb:Crumb,page='',query='')=>{setLoading(true);setErr('');try{
  const r=await localApi<{entries:BrowseEntry[];next_page:string|null}>('/api/drive/library/browse?'+new URLSearchParams({folder:crumb.id,...(page?{page}:{}),...(query?{q:query}:{}),...(crumb.path===null?{outside:'1'}:{path:crumb.path})}));
  setEntries(old=>page?[...old,...r.entries]:r.entries);setNext(r.next_page)}catch(e){setErr((e as Error).message)}finally{setLoading(false)}},[]);
 useEffect(()=>{if(here)void load(here,'',q)},[here,load]);// eslint-disable-line react-hooks/exhaustive-deps
 if(!root)return <p className="notice">{t('Сначала выберите папку моделей.','Choose a model folder first.')}</p>;
 const open=(f:{id:string;name:string})=>{setQ('');setTrail([...trail,{id:f.id,name:f.name,path:here.path===null?null:(here.path?here.path+'/':'')+f.name}])};
 const up=async()=>{if(trail.length>1){setTrail(trail.slice(0,-1));return}setLoading(true);try{const r=await localApi<{parent:{id:string;name:string}|null}>('/api/drive/library/parent?id='+encodeURIComponent(here.id));if(r.parent){setAbove([...above,here]);setTrail([{id:r.parent.id,name:r.parent.name,path:null}])}else setErr(t('Выше папок нет (корень Google Drive).','There is nothing above (Google Drive root).'))}catch(e){setErr((e as Error).message)}finally{setLoading(false)}};
 const shown=entries.filter(e=>e.type==='folder'||!onlyModels||e.model);
 return <div className="stack" aria-label={t('Папки Google Drive','Google Drive folders')}>
  <nav className="row lib-crumbs" aria-label={t('Путь','Path')}>
   <button className="pill" disabled={loading} onClick={()=>void up()} aria-label={t('Вверх','Up')}><FolderUp size={14}/></button>
   {trail.map((c,i)=><button key={c.id+i} className={'pill '+(i===trail.length-1?'selected':'')} disabled={loading} onClick={()=>{setTrail(trail.slice(0,i+1))}}>{c.name}</button>)}
   {trail[0]?.path===null&&<button className="pill" onClick={()=>{setAbove([]);setTrail([{id:root.id,name:root.name,path:''}])}}>{t('← к выбранной папке','← back to selected folder')}</button>}
  </nav>
  {trail[0]?.path===null&&<p className="tiny muted" style={{margin:0}}>{t('Вы вне выбранной папки моделей: только просмотр. Выбранная папка не меняется.','You are outside the selected model folder: view only. The selected folder is unchanged.')}</p>}
  <form className="row" onSubmit={e=>{e.preventDefault();void load(here,'',q)}}><input className="grow" value={q} onChange={e=>setQ(e.target.value)} placeholder={t('Поиск в этой папке','Search in this folder')} aria-label={t('Поиск в папке','Search in folder')}/><button type="submit" disabled={loading}><Search size={15}/></button><button type="button" disabled={loading} onClick={()=>void load(here,'',q)} aria-label={t('Обновить','Refresh')}><RefreshCw size={15}/></button></form>
  <label className="row tiny"><input type="checkbox" checked={onlyModels} onChange={e=>setOnlyModels(e.target.checked)}/>{t('Только файлы моделей','Model files only')}</label>
  {loading&&<progress className="syncbar" aria-label={t('Загрузка папки','Loading folder')}/>}
  {err&&<p className="notice dangernotice" role="alert" style={{margin:0}}>{err}</p>}
  {!loading&&!shown.length&&!err&&<p className="tiny muted">{t('Папка пуста.','Empty folder.')}</p>}
  <div className="stack lib-list">{shown.map(e=>e.type==='folder'
   ?<button key={'d'+e.id} className="lib-folder" onClick={()=>open(e)}><Folder size={18}/><span className="grow" style={{textAlign:'left',overflowWrap:'anywhere'}}>{e.name}{e.shortcut?t(' (ярлык)',' (shortcut)'):''}</span></button>
   :e.model?<ModelCard key={'f'+e.id} item={{...e,...(invById.get(e.id)||{})} as DriveItem} row={e.path?rows.get(e.path):undefined} gpuKnown={gpuKnown} selected={!!e.path&&selected.has(e.path)} busy={!!busy} onToggle={e.path&&invById.has(e.id)?()=>onToggle(e.path!):undefined} onInspect={invById.has(e.id)?()=>void inspect([e.id]):undefined}/>
   :<div key={'o'+e.id} className="card tiny muted lib-other">{e.name} · {bytesText(e.size)}{e.native?t(' · документ Google',' · Google document'):''}</div>)}</div>
  {next&&<button disabled={loading} onClick={()=>void load(here,next,q)}>{t('Ещё файлы','More files')}</button>}
  {shown.some(e=>e.type==='file'&&e.model&&!invById.has(e.id))&&<p className="tiny muted" style={{margin:0}}>{t('Чтобы выбрать файл для синхронизации, сначала нажмите «Проверить Google Drive».','To select a file for synchronization, press “Check Google Drive” first.')}</p>}
 </div>;
}
