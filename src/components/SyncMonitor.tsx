'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowRightLeft,RotateCcw,Square,Download,ExternalLink} from 'lucide-react';
import {useLibrary,bytesText,durationText,savedJobId,type MonitorView,type CompareRow} from '@/lib/model-library';
import {useDirect} from '@/lib/engine/direct';
import {useT} from './DriveLibrary';

// v1.7.6 · Google Drive → CloudCompute monitor. Shows only what the GPU's sync job reported (bytes, speed, states);
// when speed or ETA cannot be derived from those values it says so instead of estimating.
const STATE_STYLE:Record<string,string>={IDLE:'idle',CHECKING_DRIVE:'warn',COMPARING_FILES:'warn',WAITING_FOR_GPU:'idle',DOWNLOADING:'warn',VERIFYING:'warn',COMPLETED:'ok',CANCELLED:'idle',ERROR:'bad'};
const PHASE:Record<string,[string,string]>={LISTING:['чтение списка Google Drive','reading the Google Drive listing'],COMPARING:['сравнение с GPU','comparing with the GPU'],HASHING_LOCAL:['проверка файла на GPU','checking a file on the GPU'],DOWNLOADING:['загрузка','downloading'],VERIFYING_PARTIAL:['проверка частичной загрузки','checking the partial download'],VERIFYING:['проверка контрольной суммы и safetensors','verifying checksum and safetensors'],INSTALLING:['атомарная установка','atomic install'],DONE:['готово','done']};
const EVENT:Record<string,[string,string]>={JOB_STARTED:['Задание запущено','Job started'],JOB_FOUND:['Найдено задание на GPU','Job found on GPU'],STAGE:['Этап','Stage'],FILE_STARTED:['Файл','File'],FILE_INSTALLED:['Установлен и проверен','Installed and verified'],FILE_FAILED:['Ошибка файла','File failed'],JOB_FINISHED:['Задание завершено','Job finished'],GPU_UNREACHABLE:['Связь с GPU потеряна','GPU unreachable'],GPU_RECONNECTED:['Связь с GPU восстановлена','GPU reachable again'],INVENTORY_REFRESHED:['Каталог GPU обновлён','GPU catalogue refreshed']};
const ERROR_KIND:Record<string,[string,string]>={sync:['Ошибка синхронизации','Synchronization error'],gpu:['Ошибка связи с GPU','GPU connection error'],drive:['Ошибка доступа Google Drive','Google Drive access error']};

export function SyncMonitor(){
 const {en,t}=useT();const m=useLibrary(s=>s.monitor),busy=useLibrary(s=>s.busy),error=useLibrary(s=>s.error),lib=useLibrary(s=>s.library);const {loadMonitor,start,cancel,loadLibrary}=useLibrary.getState();
 const gpuName=useDirect(x=>x.info?.gpu_name),provider=useDirect(x=>x.provider),url=useDirect(x=>x.url),refreshModels=useDirect(x=>x.refresh);
 const [restoring]=useState(()=>savedJobId());const lastJobState=useRef('');
 const running=m?.job?.state==='RUNNING';
 useEffect(()=>{void loadMonitor(false).then(()=>loadMonitor())},[loadMonitor,url]);
 useEffect(()=>{void loadLibrary()},[loadLibrary,url]);
 useEffect(()=>{if(!running)return;const id=setInterval(()=>{if(document.visibilityState==='visible')void loadLibrary()},8000);return()=>clearInterval(id)},[running,loadLibrary]);   // saved selection and comparison, also when this tab opens first
 useEffect(()=>{const tick=()=>{if(document.visibilityState==='visible')void loadMonitor()};const id=setInterval(tick,running?2000:10000);document.addEventListener('visibilitychange',tick);window.addEventListener('online',tick);return()=>{clearInterval(id);document.removeEventListener('visibilitychange',tick);window.removeEventListener('online',tick)}},[running,loadMonitor]);
 // A finished job changes what is on the GPU: reload the comparison and the generator's model list.
 useEffect(()=>{const s=m?.job?`${m.job.id}:${m.job.state}`:'';if(lastJobState.current&&s!==lastJobState.current&&m?.job?.state!=='RUNNING'){void loadLibrary();void refreshModels(true)}lastJobState.current=s},[m,loadLibrary,refreshModels]);
 const cc=provider==='cloudcompute'&&!!url;const selCount=Object.keys(lib?.selection?.items||{}).length;
 if(!m)return <section className="panel" data-localized="true" aria-label="GOOGLE DRIVE → CLOUDCOMPUTE"><h2>GOOGLE DRIVE → CLOUDCOMPUTE</h2>{restoring?<p className="tiny muted">{t(`Восстанавливаю задание #${restoring} с сервера…`,`Restoring job #${restoring} from the server…`)}</p>:null}<progress className="syncbar" aria-label={t('Загрузка состояния','Loading state')}/></section>;
 const cur=m.current,o=m.overall,[stRu,stEn]=m.state_text;
 const speed=(bps:number|null|undefined,src:string|null|undefined)=>bps?`${bytesText(bps)}/s${src==='OBSERVED'?t(' (по наблюдению телефона)',' (observed by the phone)'):''}`:running&&m.job?.phase==='DOWNLOADING'?t('Вычисляется…','Calculating…'):t('Недоступно','Unavailable');
 const eta=(s:number|null|undefined)=>s!=null?durationText(s,en):running&&m.job?.phase==='DOWNLOADING'?t('Вычисляется…','Calculating…'):t('Недоступно','Unavailable');
 return <section className="panel stack" data-localized="true" aria-label="GOOGLE DRIVE → CLOUDCOMPUTE">
  <div className="row" style={{justifyContent:'space-between'}}><h2 style={{margin:0}}><ArrowRightLeft size={18} style={{verticalAlign:'-3px'}}/> GOOGLE DRIVE → CLOUDCOMPUTE</h2>
   <span className={'lib-badge '+STATE_STYLE[m.state]} role="status" data-testid="sync-state">{stRu.toUpperCase()} · {stEn.toUpperCase()}</span></div>
  <dl className="lib-indicators compact">
   <div data-tone={cc?'ok':'idle'}><dt>GPU</dt><dd>{cc?gpuName||t('подключён','connected'):t('не подключён','not connected')}</dd></div>
   <div data-tone={m.source==='LIVE'?'ok':m.source==='LAST_KNOWN'?'warn':'idle'}><dt>{t('Данные','Data')}</dt><dd>{m.source==='LIVE'?t('в реальном времени','live'):m.source==='LAST_KNOWN'?t('последнее известное','last known'):t('нет','none')}{m.observed_at?' · '+new Date(m.observed_at).toLocaleTimeString(en?'en-GB':'ru-RU'):''}</dd></div>
   {m.job&&<div><dt>{t('Задание','Job')}</dt><dd>#{m.job.id} · {m.job.type==='sync'?t('синхронизация','sync'):t('проверка','check')}</dd></div>}
   <div data-tone={selCount?'ok':'idle'}><dt>{t('Выбрано моделей','Selected models')}</dt><dd>{selCount}{m.selection_pending?t(` · ждут загрузки: ${m.selection_pending}`,` · pending: ${m.selection_pending}`):''}</dd></div>
  </dl>
  {restoring&&m.job&&restoring===m.job.id&&m.source!=='NONE'&&<p className="tiny muted" style={{margin:0}}>{t('Состояние задания восстановлено после перезагрузки страницы. Загрузка не перезапускалась.','Job state restored after the page reload. The download was not restarted.')}</p>}
  {m.state==='WAITING_FOR_GPU'&&<p className="notice" style={{margin:0}}>{t(`Выбрано ${m.selection_pending} моделей для загрузки. Подключите GPU CloudCompute на странице GPU — синхронизация использует сохранённый выбор.`,`${m.selection_pending} models are waiting. Connect a CloudCompute GPU on the GPU page — the sync will use the saved selection.`)}</p>}
  {cur&&<div className="card stack lib-progress" aria-live="polite" style={{gap:7}}>
   <b className="lib-name">{cur.name}</b>
   <span className="tiny muted">{cur.kind} · {en?PHASE[cur.phase]?.[1]||cur.phase:PHASE[cur.phase]?.[0]||cur.phase}{cur.resumed_from?` · ${t('продолжено с','resumed from')} ${bytesText(cur.resumed_from)}`:''}</span>
   {cur.percent===null?<progress className="syncbar" aria-label={t('Текущий файл: объём неизвестен','Current file: size unknown')}/>:<progress className="syncbar" max={100} value={cur.percent} aria-label={t('Текущий файл','Current file')}/>}
   <div className="lib-numbers"><span><b>{cur.percent===null?'—':cur.percent+'%'}</b></span><span>{bytesText(cur.bytes_done)} / {bytesText(cur.bytes_total)}</span><span>{t('Скорость','Speed')}: {speed(cur.speed_bps,cur.speed_source)}</span><span>{t('Осталось','Remaining')}: {eta(cur.eta_seconds)}</span></div>
  </div>}
  {o&&m.job?.type==='sync'&&o.files_total>0&&<div className="stack" style={{gap:6}}>
   <span className="tiny">{t('Файлы','Files')}: <b>{o.files_done} / {o.files_total}</b> · {t('осталось','remaining')}: {o.files_remaining}{o.files_failed?` · ${t('ошибок','failed')}: ${o.files_failed}`:''} · {bytesText(o.bytes_done)} / {bytesText(o.bytes_total)}{o.percent!==null?` · ${o.percent}%`:''}{running?` · ${t('всего осталось','total remaining')}: ${eta(o.eta_seconds)}`:''}</span>
   {o.percent!==null&&<progress className="syncbar" max={100} value={o.percent} aria-label={t('Общий прогресс','Overall progress')}/>}
  </div>}
  {running&&!cur&&<progress className="syncbar" aria-label={t('Выполняется, объём ещё неизвестен','Working, size not known yet')}/>}
  {m.state==='COMPLETED'&&m.job?.type==='sync'&&<p className="notice" style={{margin:0}}>{o&&o.files_total===0?t('Все выбранные модели уже на GPU: загружать нечего.','All selected models are already on the GPU: nothing to download.'):t(`Готово: ${o?.files_done} файлов скачано и проверено (контрольная сумма + safetensors).`,`Done: ${o?.files_done} files downloaded and verified (checksum + safetensors).`)}</p>}
  {m.error&&<div className="notice dangernotice stack" role="alert" style={{gap:6}}><b>{en?ERROR_KIND[m.error.kind][1]:ERROR_KIND[m.error.kind][0]}{m.error.code?` · ${m.error.code}`:''}</b><span>{m.error.message}</span>{m.error.action&&<span>{m.error.action}</span>}</div>}
  {m.job?.restart_recommended&&<p className="notice" style={{margin:0}}>{t('Обновлена модель, которая могла быть загружена в память GPU: новая версия применится после выбора другой модели.','A model that may be loaded in GPU memory was updated: the new version applies after selecting another model.')}</p>}
  {error&&<p className="notice dangernotice" role="alert" style={{margin:0}}>{error}</p>}
  <div className="row">
   <button className="primary" disabled={!!busy||!cc||running||!selCount} onClick={()=>void start('selected')}><Download size={15}/>{t(`Синхронизировать выбранные (${selCount})`,`Sync selected (${selCount})`)}</button>
   <button disabled={!!busy||!cc||running} onClick={()=>{if(confirm(t('Скачать на GPU ВСЕ недостающие модели из папки, а не только выбранные?','Download ALL missing models of the folder to the GPU, not only the selected ones?')))void start('missing')}}>{t('Все недостающие','All missing')}</button>
   <button className="danger" disabled={!!busy||!cc||!running||m.job?.cancel_requested||m.job?.owner==='other'} onClick={()=>void cancel()}><Square size={14}/>{m.job?.cancel_requested?t('Отмена запрошена…','Cancel requested…'):t('Отменить','Cancel')}</button>
   <button disabled={!!busy||!cc||running||!m.job||m.job.type!=='sync'||m.state==='COMPLETED'} onClick={()=>void start('retry')}><RotateCcw size={14}/>{t('Повторить','Retry')}</button>
  </div>
  {!cc&&<p className="tiny muted" style={{margin:0}}>{t('Синхронизация выполняется на GPU CloudCompute. Без GPU можно выбрать модели заранее на вкладке «Google Drive».','Synchronization runs on the CloudCompute GPU. Without a GPU you can pick models in advance on the “Google Drive” tab.')}</p>}
  {m.discovery&&<Discovery d={m.discovery}/>}
  <details className="lib-log"><summary>{t(`Технический журнал (${m.events.length})`,`Technical log (${m.events.length})`)}</summary>
   <ol className="tiny">{[...m.events].reverse().map((e,i)=><li key={i}><span className="muted">{new Date(e.at).toLocaleTimeString(en?'en-GB':'ru-RU')}</span> {en?EVENT[e.type]?.[1]||e.type:EVENT[e.type]?.[0]||e.type}{e.job_id?` #${e.job_id}`:''}{eventDetail(e)}</li>)}</ol>
  </details>
 </section>;
}
function eventDetail(e:Record<string,unknown>){const parts=[e.from&&e.to?`${e.from} → ${e.to}`:e.to?String(e.to):'',e.path?String(e.path):'',e.state?String(e.state):'',typeof e.bytes_total==='number'?bytesText(e.bytes_total):'',typeof e.resumed_from==='number'&&e.resumed_from?'resume '+bytesText(e.resumed_from):'',e.verification?String(e.verification):'',e.error_code?String(e.error_code):'',e.reason?String(e.reason):'',e.message?String(e.message):''].filter(Boolean);return parts.length?': '+parts.join(' · '):''}

function Discovery({d}:{d:NonNullable<MonitorView['discovery']>}){
 const {t}=useT();const text:Record<string,[string,string,string]>={AVAILABLE:['доступна в генераторе','available in the generator','ok'],AVAILABLE_UNVERIFIED:['доступна, совместимость не подтверждена','available, compatibility unconfirmed','warn'],INCOMPATIBLE:['несовместима','incompatible','bad'],NOT_FOUND:['не найдена в каталоге GPU','not in the GPU catalogue','bad'],NOT_INSTALLED:['не установлена','not installed','bad']};
 const {en}=useT();
 return <div className="card stack" style={{gap:6}} aria-label={t('Новые модели на GPU','New models on GPU')}><b>{t('ПРОВЕРКА КАТАЛОГА GPU ПОСЛЕ СИНХРОНИЗАЦИИ','GPU CATALOGUE CHECK AFTER SYNC')}</b>
  {d.error&&<span className="tiny danger">{t('Каталог не обновился: ','Catalogue not refreshed: ')}{d.error}</span>}
  {!d.files.length&&<span className="tiny muted">{t('В этом задании не было новых файлов.','No new files in this job.')}</span>}
  {d.files.map(f=><div key={f.path} className="tiny"><b>{f.name}</b> · {f.kind||'—'}{f.gpu_model?` · ${f.gpu_model.architecture}`:''} — <span className={'lib-chip '+text[f.generator][2]}>{en?text[f.generator][1]:text[f.generator][0]}</span>{f.reason&&<div className="muted">{f.reason}</div>}</div>)}
 </div>;
}

const GROUPS:[CompareRow['category'],string,string][]=[['DOWNLOADING','Загружаются сейчас','Downloading now'],['UPDATE','Требуют обновления','Need an update'],['FAILED','Не прошли проверку','Failed verification'],['DRIVE_ONLY','Только на Google Drive','Only on Google Drive'],['INSTALLED','Установлены на GPU','Installed on GPU'],['NOT_SYNCABLE','Не синхронизируются','Not synchronizable']];
export function SyncComparison(){
 const {en,t}=useT();const lib=useLibrary(s=>s.library);const [kind,setKind]=useState<string|null>(null);
 const rows=useMemo(()=>(lib?.comparison.rows||[]).filter(r=>!kind||r.kind===kind),[lib,kind]);
 if(!lib)return null;
 const observed=lib.gpu.sync_observed_at;
 return <section className="panel stack" data-localized="true" aria-label={t('Сравнение Google Drive и GPU','Google Drive vs GPU')}>
  <h2 style={{margin:0}}>{t('GOOGLE DRIVE ⇄ GPU','GOOGLE DRIVE ⇄ GPU')}</h2>
  <p className="tiny muted" style={{margin:0}}>{!lib.inventory?t('Сначала проверьте Google Drive на вкладке «Google Drive».','Check Google Drive on the “Google Drive” tab first.'):observed?t(`Состояние на GPU — по данным синхронизации от ${new Date(observed).toLocaleString('ru-RU')}${lib.gpu.sync_live?'':' (GPU сейчас не на связи: данные могут устареть)'}.`,`GPU state from the sync report of ${new Date(observed).toLocaleString('en-GB')}${lib.gpu.sync_live?'':' (GPU not reachable now: may be outdated)'}.`):t('GPU ещё не сообщал состояние файлов: «Установлена на GPU» не показывается, пока GPU это не подтвердит.','The GPU has not reported file states yet: nothing is shown as installed until the GPU confirms it.')}</p>
  <div className="row" role="tablist" aria-label={t('Тип модели','Model type')}>{[['ВСЕ',null],['CHECKPOINTS','checkpoint'],['LORA','lora'],['VAE','vae'],['CONTROLNET','controlnet']].map(([l,k])=><button key={String(l)} role="tab" aria-selected={kind===k} className={'pill '+(kind===k?'selected':'')} onClick={()=>setKind(k)}>{l==='ВСЕ'?t('ВСЕ','ALL'):l}</button>)}</div>
  {GROUPS.map(([cat,ru,eng])=>{const list=rows.filter(r=>r.category===cat);if(!list.length)return null;return <details key={cat} open={['DOWNLOADING','UPDATE','FAILED'].includes(cat)} className="lib-group" data-category={cat}>
   <summary><b>{en?eng:ru}</b> <span className="muted">({list.length})</span></summary>
   <ul>{list.map(r=><li key={r.path}><span className="lib-name">{r.name}</span>{r.selected&&<span className="lib-chip ok">{t('выбрана','selected')}</span>} <span className="tiny muted">{r.kind} · {bytesText(r.size)}{r.gpu_model?` · GPU: ${r.gpu_model.architecture}${r.gpu_model.compatible===false?t(' · несовместима',' · incompatible'):''}`:''}</span>{r.reason&&<div className="tiny muted">{r.reason}</div>}{r.gpu_model?.reason&&r.gpu_model.compatible===false&&<div className="tiny danger">{r.gpu_model.reason}</div>}</li>)}</ul>
  </details>})}
  {lib.comparison.gpu_only.length>0&&<details className="lib-group" data-category="GPU_ONLY"><summary><b>{t('Только на GPU','Only on GPU')}</b> <span className="muted">({lib.comparison.gpu_only.length})</span></summary><ul>{lib.comparison.gpu_only.filter(m=>!kind||m.kind===kind).map(m=><li key={m.id}><span className="lib-name">{m.name}</span> <span className="tiny muted">{m.kind}</span>{m.reason&&<div className="tiny muted">{m.reason}</div>}</li>)}</ul></details>}
  <a className="btn" href="https://app.cloudcompute.ru/" target="_blank" rel="noreferrer noopener" style={{alignSelf:'flex-start'}}><ExternalLink size={15}/>{t('Панель CloudCompute','CloudCompute dashboard')}</a>
 </section>;
}
