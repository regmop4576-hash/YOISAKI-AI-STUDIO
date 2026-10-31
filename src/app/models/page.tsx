'use client';
import {useEffect,useState} from 'react';import {Head,Tabs} from '@/components/Common';import {Boxes} from 'lucide-react';import {LoraTagEditor} from '@/components/LoraTagEditor';import {useDirect} from '@/lib/engine/direct';import type {LiveModel as RemoteModel} from '@/lib/engine/live';import {GoogleAccount} from '@/components/GoogleAccount';import {DriveSync} from '@/components/DriveSync';
import {DriveLibrary,useT} from '@/components/DriveLibrary';import {SyncMonitor,SyncComparison} from '@/components/SyncMonitor';import {GpuReadiness} from '@/components/GpuReadiness';import {useLibrary} from '@/lib/model-library';
// v1.7.6: three separate sources — Google Drive (works without a GPU), the models really installed on the GPU, and the
// synchronization between them. Cloud availability is never shown as GPU availability.
type Source='drive'|'gpu'|'sync';
const TAB_KEY='yoisaki.models.tab';
export default function Page(){
 const {t}=useT();const online=useDirect(x=>['READY','BUSY','LOADING'].includes(x.state));
 const [source,setSource]=useState<Source|null>(null);const sync=useLibrary(s=>s.readiness?.sync);
 useEffect(()=>{let saved:string|null=null;try{saved=localStorage.getItem(TAB_KEY)}catch{}setSource(saved==='drive'||saved==='gpu'||saved==='sync'?saved:online?'gpu':'drive')},[]);// eslint-disable-line react-hooks/exhaustive-deps
 const choose=(s:Source)=>{setSource(s);try{localStorage.setItem(TAB_KEY,s)}catch{}};
 const busySync=sync&&['CHECKING_DRIVE','COMPARING_FILES','DOWNLOADING','VERIFYING'].includes(sync.state);
 const tabs:[Source,string][]=[['drive','GOOGLE DRIVE'],['gpu',t('МОДЕЛИ GPU','GPU MODELS')],['sync',t('СИНХРОНИЗАЦИЯ','SYNCHRONIZATION')+(busySync?' ●':sync?.state==='ERROR'?' !':'')]];
 return <div className="page stack"><Head title="Библиотека моделей" detail="Google Drive, модели на GPU и синхронизация между ними"/>
  <GpuReadiness/>
  <GoogleAccount/>
  <div className="row lib-sources" role="tablist" aria-label={t('Источник моделей','Model source')} data-localized="true">{tabs.map(([k,label])=><button key={k} type="button" role="tab" aria-selected={source===k} className={'pill lib-source '+(source===k?'selected':'')} onClick={()=>choose(k)}>{label}</button>)}</div>
  {source==='drive'&&<DriveLibrary/>}
  {source==='gpu'&&<GpuModels/>}
  {source==='sync'&&<><SyncMonitor/><SyncComparison/><details className="panel lib-legacy"><summary>{t('Расширенная панель GPU · GOOGLE DRIVE AUTO SYNC','Advanced GPU panel · GOOGLE DRIVE AUTO SYNC')}</summary><DriveSync/></details></>}
 </div>;
}

// Models actually installed on the connected GPU (the engine catalogue). Without a GPU the saved list is shown as cached.
function GpuModels(){const {t}=useT();const online=useDirect(x=>['READY','BUSY','LOADING'].includes(x.state));const remote=useDirect(x=>x.models),sync=useDirect(x=>x.refresh),[tab,setTab]=useState('CHECKPOINTS'),[query,setQuery]=useState(''),[models,setModels]=useState<RemoteModel[]>([]),[info,setInfo]=useState(''),[editing,setEditing]=useState<RemoteModel|null>(null);
const stale=useDirect(x=>x.models_stale);
const modelsError=useDirect(x=>x.models_error),rejected=useDirect(x=>x.models_rejected)||[],updated=useDirect(x=>x.models_updated_at);
async function refresh(){await sync(true);const st=useDirect.getState();setInfo(st.error||(st.models_error?'Список моделей не обновился: '+st.models_error:''))}
useEffect(()=>{setModels(remote)},[remote]);
const visible=models.filter(x=>x.kind===({CHECKPOINTS:'checkpoint',LORA:'lora',VAE:'vae',CONTROLNET:'controlnet'} as Record<string,string>)[tab]&&x.name.toLowerCase().includes(query.toLowerCase()));
return <><div className="panel stack" aria-label="GPU MODELS"><h2 style={{margin:0}} data-localized="true">{t('МОДЕЛИ НА GPU','MODELS ON GPU')}</h2>{!online&&models.length>0&&<div className="notice dangernotice" role="status" data-localized="true">{t('GPU отключён: ниже сохранённый список (кэш). Эти модели сейчас недоступны для генерации.','GPU disconnected: below is the saved list (cache). These models are not available for generation now.')}</div>}{online&&stale&&<div className="notice" role="status">Каталог не подтверждён: показан сохранённый список. Обновите модели при доступном GPU.</div>}<Tabs options={['CHECKPOINTS','LORA','VAE','CONTROLNET']} value={tab} onChange={setTab}/><div className="row"><input className="grow" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Поиск модели" aria-label="Поиск модели"/><button onClick={refresh}>Обновить</button></div>{visible.length? <div className="stack">{visible.map(m=><div className="card stack" key={m.id}><b>{m.name}</b>{online?<span className="tiny lib-chip ok" style={{alignSelf:'flex-start'}} data-localized="true">{t('Установлена на GPU','Installed on GPU')}</span>:<span className="tiny muted" data-localized="true">{t('GPU отключён · модель недоступна (кэш)','GPU offline · model unavailable (cached)')}</span>}<div className="muted tiny">{m.kind} · {m.architecture} · {m.size_bytes===null?'—':Math.round(m.size_bytes/1048576)+' MB'}</div><div className="tiny">{m.compatible===true?'Совместима':m.compatible===false?'Несовместима':'Совместимость не определена'}</div>{m.base_model&&<div className="muted tiny">Базовая модель в метаданных: {m.base_model}</div>}{m.compatibility_reason&&<div className={m.compatible===false?'tiny danger':'tiny muted'}>{m.compatibility_reason}</div>}{m.kind==='lora'&&<button onClick={()=>setEditing(m)}>+ Теги</button>}</div>)}</div>:<div className="empty-models"><Boxes size={36}/><h3>Нет доступных моделей</h3><p>Подключите GPU-движок и обновите список. Неизвестные модели не считаются установленными.</p><p className="tiny muted" data-localized="true">{t('Файлы Google Drive — на вкладке GOOGLE DRIVE.','Google Drive files are on the GOOGLE DRIVE tab.')}</p></div>}{info&&<div className="notice">{info}</div>}{!info&&modelsError&&<div className="notice">Список моделей не обновился: {modelsError} Показан прежний список.</div>}{updated&&<p className="tiny muted">Список получен {new Date(updated).toLocaleString('ru-RU')}{online?'':' (GPU сейчас отключён)'}</p>}{rejected.length>0&&<div className="notice">Записи каталога GPU, которые не удалось прочитать: {rejected.map(r=>r.name+' — '+r.reason).join('; ')}</div>}</div>{editing&&<LoraTagEditor id={editing.id} name={editing.name} onClose={()=>setEditing(null)}/>}</>}
