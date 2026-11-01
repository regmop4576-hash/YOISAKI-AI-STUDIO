'use client';
// v1.9.0 PIXEL FANTASY · Models. Three real sources (v1.7.6): Google Drive (works without a GPU), the models really
// installed on the connected GPU, and the GPU sync (CloudCompute only). Cloud availability is never shown as GPU
// availability, and nothing here is invented: rows come from the engine catalogue or from Google Drive.
import {useEffect,useState} from 'react';
import {Tabs} from '@/components/Common';
import {LoraTagEditor} from '@/components/LoraTagEditor';
import {useDirect} from '@/lib/engine/direct';
import type {LiveModel as RemoteModel} from '@/lib/engine/live';
import {GoogleAccount} from '@/components/GoogleAccount';
import {DriveSync} from '@/components/DriveSync';
import {DriveLibrary} from '@/components/DriveLibrary';
import {SyncMonitor,SyncComparison} from '@/components/SyncMonitor';
import {GpuReadiness} from '@/components/GpuReadiness';
import {useLibrary} from '@/lib/model-library';
import {useStudio} from '@/stores/studio';
import {ModelRow} from '@/components/Generator';
import {Boxes,RefreshCw,Search,MoreV,Plus,Check,Sparkles,CloudDownload} from '@/components/icons';
import {PageHead,Modal,toast,ActionButton,SectionTitle,useCloudComputeVisible} from '@/components/ui';
import {useI18n} from '@/i18n';
type Source='drive'|'gpu'|'sync';
const TAB_KEY='yoisaki.models.tab';
export default function Page(){
 const {t}=useI18n();const online=useDirect(x=>['READY','BUSY','LOADING'].includes(x.state));const cc=useCloudComputeVisible();
 const [source,setSource]=useState<Source|null>(null);const sync=useLibrary(s=>s.readiness?.sync);
 useEffect(()=>{let saved:string|null=null;try{saved=localStorage.getItem(TAB_KEY)}catch{}setSource(saved==='drive'||saved==='gpu'||saved==='sync'&&cc?saved as Source:online?'gpu':'drive')},[]);// eslint-disable-line react-hooks/exhaustive-deps
 const choose=(s:Source)=>{setSource(s);try{localStorage.setItem(TAB_KEY,s)}catch{}};
 const busySync=sync&&['CHECKING_DRIVE','COMPARING_FILES','DOWNLOADING','VERIFYING'].includes(sync.state);
 const tabs:Source[]=cc?['gpu','drive','sync']:['gpu','drive'];
 const labels={gpu:t('mod.tabGpu'),drive:'Google Drive',sync:t('mod.tabSync')+(busySync?' ●':sync?.state==='ERROR'?' !':'')};
 return <div className="page stack"><PageHead icon={<Boxes size={24}/>} title={t('nav.models')} detail={t('mod.detail')}/>
  <Tabs options={tabs} value={source||'gpu'} onChange={v=>choose(v as Source)} labels={labels}/>
  {source==='gpu'&&<GpuModels onImport={()=>choose('drive')}/>}
  {source==='drive'&&<><GoogleAccount/><DriveLibrary/></>}
  {source==='sync'&&cc&&<><GpuReadiness/><SyncMonitor/><SyncComparison/><details className="panel lib-legacy"><summary>{t('mod.advancedSync')}</summary><DriveSync/></details></>}
 </div>;
}
type Kind='checkpoint'|'lora'|'vae'|'controlnet';
function GpuModels({onImport}:{onImport:()=>void}){
 const {t,locale}=useI18n();const online=useDirect(x=>['READY','BUSY','LOADING'].includes(x.state));const remote=useDirect(x=>x.models),refreshModels=useDirect(x=>x.refresh),hasUrl=useDirect(x=>!!x.url);
 const [tab,setTab]=useState<Kind>('checkpoint'),[query,setQuery]=useState(''),[editing,setEditing]=useState<RemoteModel|null>(null),[menu,setMenu]=useState<RemoteModel|null>(null);
 const stale=useDirect(x=>x.models_stale),modelsError=useDirect(x=>x.models_error),rejected=useDirect(x=>x.models_rejected)||[],updated=useDirect(x=>x.models_updated_at);
 const settings=useStudio(s=>s.settings),update=useStudio(s=>s.update);
 const visible=remote.filter(x=>x.kind===tab&&x.name.toLowerCase().includes(query.trim().toLowerCase()));
 const count=(k:Kind)=>remote.filter(x=>x.kind===k).length;
 const inUse=(m:RemoteModel)=>m.kind==='checkpoint'?settings.checkpoint===m.id:m.kind==='vae'?settings.vae===m.id:m.kind==='lora'?settings.loras.some(l=>l.id===m.id):false;
 async function refresh(){await refreshModels(true);const st=useDirect.getState();if(st.error||st.models_error)throw Error(st.error||t('models.notRefreshed',{err:st.models_error||''}))}
 return <section className="panel stack" aria-label={t('mod.tabGpu')} data-localized="true">
  <SectionTitle icon={<Boxes size={20}/>} right={<span className={'lib-badge '+(online?'ok':'')}>{online?t('mod.online'):t('mod.offline')}</span>}>{t('mod.onGpu')}</SectionTitle>
  {!online&&remote.length>0&&<div className="notice dangernotice" role="status">{t('mod.cacheNote')}</div>}
  {online&&stale&&<div className="notice" role="status">{t('mod.staleNote')}</div>}
  <Tabs fit options={['checkpoint','lora','vae','controlnet']} value={tab} onChange={v=>setTab(v as Kind)} labels={{checkpoint:`Checkpoints ${count('checkpoint')}`,lora:`LoRA ${count('lora')}`,vae:`VAE ${count('vae')}`,controlnet:`ControlNet ${count('controlnet')}`}}/>
  <div className="row"><input className="grow" type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder={t('picker.searchModels')} aria-label={t('picker.searchModels')}/><ActionButton className="icon" aria-label={t('models.refresh')} title={t('models.refresh')} disabled={!hasUrl} onAction={refresh} successText={t('models.refreshed')}><RefreshCw size={18}/></ActionButton></div>
  {visible.length?<div className="px-list">{visible.map(m=><ModelRow key={m.id} m={m} on={inUse(m)} onClick={()=>setMenu(m)} right={<MoreV size={18}/>}/>)}</div>
   :<div className="empty-models"><Search size={32}/><h3>{remote.length?t('picker.nothingFound'):t('mod.emptyTitle')}</h3><p>{t('mod.emptyText')}</p></div>}
  <button type="button" className="block" onClick={onImport}><CloudDownload size={18}/>{t('mod.import')}</button>
  {!hasUrl&&<p className="tiny muted">{t('mod.importNote')}</p>}
  {modelsError&&<div className="notice">{t('models.notRefreshed',{err:modelsError})} {t('models.staleShown')}</div>}
  {updated&&<p className="tiny muted">{t('mod.listAt',{time:new Date(updated).toLocaleString(locale)})}{online?'':' · '+t('mod.gpuOffNow')}</p>}
  {rejected.length>0&&<div className="notice">{t('mod.rejected')}: {rejected.map(r=>r.name+' — '+r.reason).join('; ')}</div>}
  {menu&&<Modal title={menu.name} onClose={()=>setMenu(null)} label={t('mod.actions')}>
   <div className="px-list"><ModelRow m={menu} on={inUse(menu)}/>
    {menu.base_model&&<p className="tiny muted">{t('mod.baseModel')}: {menu.base_model}</p>}
    {menu.compatibility_reason&&<p className={'tiny '+(menu.compatible===false?'danger':'muted')}>{menu.compatibility_reason}</p>}
    {(menu.kind==='checkpoint'||menu.kind==='vae')&&<button type="button" className="px-row" disabled={menu.compatible===false||inUse(menu)} onClick={()=>{update(menu.kind==='checkpoint'?{checkpoint:menu.id}:{vae:menu.id});toast('ok',t('mod.selected',{name:menu.name}));setMenu(null)}}><Check size={20}/>{inUse(menu)?t('mod.inUse'):t('mod.useForGen')}</button>}
    {menu.kind==='vae'&&inUse(menu)&&<button type="button" className="px-row" onClick={()=>{update({vae:'auto'});toast('ok',t('mod.vaeReset'));setMenu(null)}}><Boxes size={20}/>{t('picker.vaeDefault')}</button>}
    {menu.kind==='lora'&&<button type="button" className="px-row" disabled={menu.compatible===false} onClick={()=>{if(inUse(menu))update({loras:settings.loras.filter(l=>l.id!==menu.id)});else update({loras:[...settings.loras,{id:menu.id,name:menu.name,trigger:'',weight:.8,enabled:true}]});toast('ok',inUse(menu)?t('mod.loraRemoved',{name:menu.name}):t('mod.loraAdded',{name:menu.name}));setMenu(null)}}>{inUse(menu)?<Check size={20}/>:<Plus size={20}/>}{inUse(menu)?t('mod.loraRemove'):t('mod.loraAdd')}</button>}
    {menu.kind==='lora'&&<button type="button" className="px-row" onClick={()=>{setEditing(menu);setMenu(null)}}><Sparkles size={20}/>{t('lora.tags')}</button>}
    {menu.kind==='controlnet'&&<p className="tiny muted">{t('mod.controlnetNote')}</p>}
   </div>
  </Modal>}
  {editing&&<LoraTagEditor id={editing.id} name={editing.name} onClose={()=>setEditing(null)} onSaved={()=>toast('ok',t('lora.tagsSaved'))}/>}
 </section>;
}
