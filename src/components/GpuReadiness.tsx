'use client';
import {useEffect} from 'react';
import {ExternalLink} from 'lucide-react';
import {useLibrary,bytesText,SYNC_TEXT} from '@/lib/model-library';
import {useDirect} from '@/lib/engine/direct';
import {useStudio} from '@/stores/studio';

// v1.7.6 independent indicators. READY TO GENERATE comes only from the server's readiness answer, which requires a
// passing YOISAKI ENGINE health check and a usable checkpoint — never from the CloudCompute API key alone.
type Tone='ok'|'warn'|'bad'|'idle';
export function GpuReadiness({compact=false}:{compact?:boolean}){
 const en=useStudio(s=>s.language)==='English',t=(r:string,e:string)=>en?e:r;
 const r=useLibrary(s=>s.readiness),load=useLibrary(s=>s.loadReadiness);
 const phase=useDirect(x=>x.phase),gpuState=useDirect(x=>x.state);
 useEffect(()=>{void load();const id=setInterval(()=>{if(document.visibilityState==='visible')void load()},5000);const vis=()=>{if(document.visibilityState==='visible')void load()};document.addEventListener('visibilitychange',vis);return()=>{clearInterval(id);document.removeEventListener('visibilitychange',vis)}},[load,phase,gpuState]);
 if(!r)return <section className="panel lib-ready" aria-label="CLOUDCOMPUTE" data-localized="true"><h2>CLOUDCOMPUTE</h2><progress className="syncbar" aria-label={t('Проверка состояния','Checking status')}/></section>;
 const engineText:Record<string,[string,string,Tone]>={READY:['ГОТОВ','READY','ok'],NOT_CONNECTED:['НЕ ПОДКЛЮЧЁН','NOT CONNECTED','idle'],CONNECTING:['ПОДКЛЮЧЕНИЕ','CONNECTING','warn'],LOADING:['ЗАГРУЗКА','LOADING','warn'],ERROR:['ОШИБКА','ERROR','bad']};
 const inst=r.cloudcompute.instance;
 const rows:[string,string,Tone][]=[
  [t('API','API'),r.cloudcompute.api==='CONFIGURED'?t('КЛЮЧ СОХРАНЁН','KEY SAVED'):t('НЕ НАСТРОЕН','NOT CONFIGURED'),r.cloudcompute.api==='CONFIGURED'?'ok':'idle'],
  [t('ИНСТАНС','INSTANCE'),inst?`#${inst.id} · ${(inst.status||'UNKNOWN').toUpperCase()}`:t('НЕ СОЗДАН ЗДЕСЬ','NOT CREATED HERE'),inst?inst.running?'ok':inst.stage==='INSTANCE_GONE'?'idle':'warn':'idle'],
  [t('ДВИЖОК','ENGINE'),(en?engineText[r.engine.state][1]:engineText[r.engine.state][0])+(r.engine.version?` · ${r.engine.version}`:''),engineText[r.engine.state][2]],
  ['CUDA',r.cuda==='AVAILABLE'?t('ДОСТУПНА','AVAILABLE'):r.cuda==='FAILED'?t('ОШИБКА','FAILED'):t('НЕ ПРОВЕРЕНА','NOT CHECKED'),r.cuda==='AVAILABLE'?'ok':r.cuda==='FAILED'?'bad':'idle'],
  ['GPU',r.gpu.name||'—',r.gpu.name?'ok':'idle'],
  ['VRAM',r.gpu.vram_total_mb!=null?`${Math.round(r.gpu.vram_total_mb/1024)} GB`+(r.gpu.vram_available_mb!=null?` (${t('свободно','free')} ${Math.round(r.gpu.vram_available_mb/1024)} GB)`:''):'—',r.gpu.vram_total_mb!=null?'ok':'idle'],
  [t('ДИСК МОДЕЛЕЙ','MODEL STORAGE'),r.storage&&r.storage.free_bytes!=null?`${bytesText(r.storage.free_bytes)} ${t('свободно','free')}${r.storage.source==='LIVE'?'':' · '+t('последнее известное','last known')}`:'—',r.storage&&r.storage.free_bytes!=null?r.storage.free_bytes>(r.storage.reserve_bytes||0)*2?'ok':'warn':'idle'],
  ['GOOGLE DRIVE',r.drive.phone==='CONNECTED'?t('ПОДКЛЮЧЁН','CONNECTED')+(r.drive.on_gpu==='OK'?t(' · GPU: доступ проверен',' · GPU: verified'):r.drive.on_gpu==='ERROR'?t(' · GPU: ошибка доступа',' · GPU: access error'):r.drive.on_gpu==='NOT_CONFIGURED'?t(' · GPU: не передан',' · GPU: not shared'):''):t('НЕ ПОДКЛЮЧЁН','NOT CONNECTED'),r.drive.phone!=='CONNECTED'?'idle':r.drive.on_gpu==='ERROR'?'bad':'ok'],
  [t('СИНХРОНИЗАЦИЯ','SYNC'),r.sync?`${(en?SYNC_TEXT[r.sync.state]?.[1]:SYNC_TEXT[r.sync.state]?.[0])||r.sync.state}${r.sync.files_total?` · ${r.sync.files_done}/${r.sync.files_total} ${t('файлов','files')}`:''}${r.sync.source==='LAST_KNOWN'?' · '+t('последнее известное','last known'):''}`:'—',!r.sync?'idle':r.sync.state==='ERROR'?'bad':r.sync.state==='COMPLETED'||r.sync.state==='IDLE'?'ok':'warn'],
 ];
 return <section className="panel stack lib-ready" aria-label="CLOUDCOMPUTE" data-localized="true">
  <div className="row" style={{justifyContent:'space-between'}}><h2 style={{margin:0}}>{t('CLOUDCOMPUTE · СОСТОЯНИЕ','CLOUDCOMPUTE · STATUS')}</h2>
   <span className={'lib-badge '+(r.ready_to_generate?'ok':'idle')} role="status" data-testid="ready-badge">{r.ready_to_generate?t('ГОТОВ К ГЕНЕРАЦИИ','READY TO GENERATE'):t('НЕ ГОТОВ','NOT READY')}</span></div>
  <dl className={'lib-indicators'+(compact?' compact':'')}>{rows.map(([k,v,tone])=><div key={k} data-tone={tone}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
  {!r.ready_to_generate&&r.ready_reason&&<p className="tiny muted" style={{margin:0}}>{r.ready_reason}</p>}
  {r.engine.error&&r.engine.state==='ERROR'&&<p className="notice dangernotice" role="alert" style={{margin:0}}>{t('Ошибка связи с GPU: ','GPU connection error: ')}{r.engine.error}</p>}
  {r.warnings.map(w=><div className="notice dangernotice stack" role="alert" key={w.code} style={{gap:8}}><span>{w.message}</span>{w.dashboard&&<a className="btn" href={r.dashboard} target="_blank" rel="noreferrer noopener"><ExternalLink size={15}/>{t('Открыть панель CloudCompute','Open CloudCompute dashboard')}</a>}</div>)}
  {inst&&inst.stage!=='INSTANCE_GONE'&&!r.warnings.length&&<p className="tiny muted" style={{margin:0}}>{t('GPU оплачивается, пока инстанс существует. Закрытие сайта или «Отключиться» оплату не останавливает.','The GPU is billed while the instance exists. Closing the site or “Disconnect” does not stop billing.')}</p>}
 </section>;
}
