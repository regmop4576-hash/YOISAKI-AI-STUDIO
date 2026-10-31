'use client';
// v1.9.0 PIXEL FANTASY · Settings. One page, nine sections; every control changes real, persisted behaviour
// (studio settings → /api/settings in Termux, drafts → IndexedDB). No placeholder switches.
import {useEffect,useRef,useState,type ReactNode} from 'react';
import Link from 'next/link';
import {useStudio,defaults} from '@/stores/studio';
import {useSession} from '@/stores/session';
import {useDirect} from '@/lib/engine/direct';
import {clearImages,getImages} from '@/lib/storage/gallery';
import {clearAllDrafts,draftSummary} from '@/lib/storage/drafts';
import {localApi} from '@/lib/local-api';
import {STUDIO_VERSION,STUDIO_EDITION} from '@/lib/release';
import {downloadJSON} from '@/components/Common';
import {PageHead,ActionButton,toast,Modal,Mascot} from '@/components/ui';
import {Settings,Languages,Monitor,WandSparkles,Paintbrush,Boxes,Plug,Database,Images,Terminal,Download,Upload,Trash2,RotateCcw,ExternalLink,Warning} from '@/components/icons';
import {useI18n,LANGS,type MessageKey} from '@/i18n';
type Sec='general'|'interface'|'generation'|'editor'|'models'|'connections'|'storage'|'gallery'|'advanced';
const SECTIONS:[Sec,MessageKey,typeof Settings][]=[['general','set.general',Settings],['interface','set.interface',Monitor],['generation','set.generation',WandSparkles],['editor','set.editor',Paintbrush],['models','set.models',Boxes],['connections','set.connections',Plug],['storage','set.storage',Database],['gallery','set.gallery',Images],['advanced','set.advanced',Terminal]];
const KEY='yoisaki.settings.section';
function Row({title,hint,children}:{title:ReactNode;hint?:ReactNode;children:ReactNode}){return <div className="setting-row"><div><span>{title}</span>{hint&&<span className="tiny muted">{hint}</span>}</div><div className="row" style={{flex:'none',justifyContent:'flex-end'}}>{children}</div></div>}
function Switch({label,checked,onChange,hint}:{label:string;checked:boolean;onChange:(v:boolean)=>void;hint?:string}){return <label className="px-switch setting-row"><span><span>{label}</span>{hint&&<span className="tiny muted" style={{display:'block'}}>{hint}</span>}</span><input type="checkbox" role="switch" aria-label={label} checked={checked} onChange={e=>onChange(e.target.checked)}/></label>}
const mb=(n:number)=>n>1048576?(n/1048576).toFixed(1)+' MB':Math.round(n/1024)+' KB';
export default function Page(){
 const {t,locale}=useI18n();const st=useStudio();const direct=useDirect();
 const [sec,setSec]=useState<Sec>(()=>{try{const v=localStorage.getItem(KEY);return SECTIONS.some(([k])=>k===v)?v as Sec:'general'}catch{return 'general'}});
 const choose=(s:Sec)=>{setSec(s);try{localStorage.setItem(KEY,s)}catch{}};
 const file=useRef<HTMLInputElement>(null);const [drafts,setDrafts]=useState({count:0,bytes:0});const [images,setImages]=useState<number|null>(null);const [diag,setDiag]=useState('');
 const reloadStats=()=>{void draftSummary().then(setDrafts);getImages().then(x=>setImages(x.length)).catch(()=>setImages(null))};
 useEffect(reloadStats,[]);
 const ui=st.ui;
 const body:Record<Sec,ReactNode>={
  general:<>
   <div className="field"><label htmlFor="lang"><Languages size={16}/> {t('set.language')}</label><select id="lang" value={st.language} onChange={e=>{st.setLanguage(e.target.value);toast('ok',t('set.saved'))}}>{Object.values(LANGS).map(l=><option key={l.label} value={l.label}>{l.label}</option>)}</select></div>
   <div className="notice infonotice stack" style={{gap:4}}><b className="gold">{t('set.version')}: {STUDIO_VERSION} · {STUDIO_EDITION}</b><span>{t('brand.storage')}</span></div>
   <Row title={t('set.export')} hint={t('set.exportHint')}><button type="button" onClick={()=>{downloadJSON({version:1,settings:st.settings,presets:st.presets},'yoisaki-settings.json');toast('ok',t('set.exported'))}}><Download size={16}/>{t('set.exportBtn')}</button></Row>
   <Row title={t('set.import')} hint={t('set.importHint')}><button type="button" onClick={()=>file.current?.click()}><Upload size={16}/>{t('set.importBtn')}</button></Row>
   <input ref={file} hidden type="file" accept="application/json,.json" onChange={async e=>{try{const f=e.target.files?.[0];if(!f)return;if(f.size>1024*1024)throw Error(t('set.fileTooLarge'));const obj=JSON.parse(await f.text());if(obj.version!==1||!obj.settings||typeof obj.settings.prompt!=='string'||!Number.isFinite(obj.settings.width))throw Error(t('set.invalidFile'));st.update({...defaults,...obj.settings});toast('ok',t('set.imported'))}catch(err){toast('bad',(err as Error).message)}e.target.value=''}}/>
  </>,
  interface:<>
   <Switch label={t('set.motionOff')} hint={t('set.motionHint')} checked={ui.motion==='off'} onChange={v=>st.setUi({motion:v?'off':'system'})}/>
   <Switch label={t('set.compact')} hint={t('set.compactHint')} checked={ui.decor==='compact'} onChange={v=>st.setUi({decor:v?'compact':'full'})}/>
   <Switch label={t('set.plainFont')} hint={t('set.plainFontHint')} checked={ui.pixelText} onChange={v=>st.setUi({pixelText:v})}/>
   <Switch label={t('set.largeText')} hint={t('set.largeTextHint')} checked={ui.largeText} onChange={v=>st.setUi({largeText:v})}/>
   <p className="tiny muted">{t('set.themeNote')}</p>
  </>,
  generation:<>
   <div className="grid2 keep"><div className="field"><label>{t('set.defWidth')}</label><input type="number" inputMode="numeric" min="256" max="1536" step="8" value={st.settings.width} onChange={e=>st.update({width:Number(e.target.value)})}/></div><div className="field"><label>{t('set.defHeight')}</label><input type="number" inputMode="numeric" min="256" max="1536" step="8" value={st.settings.height} onChange={e=>st.update({height:Number(e.target.value)})}/></div></div>
   <Row title={t('set.presets')} hint={t('set.presetsHint')}><b className="gold">{st.presets.length}</b><Link href="/generate" className="btn">{t('nav.generate')}</Link></Row>
   <Row title={t('set.resetGen')} hint={t('set.resetGenHint')}><button type="button" onClick={()=>{if(confirm(t('presets.resetConfirm'))){st.reset();toast('ok',t('presets.reset'))}}}><RotateCcw size={16}/>{t('common.reset')}</button></Row>
  </>,
  editor:<>
   <Row title={t('set.editorMode')}><b className="gold">{st.editor.mode}</b></Row>
   <Row title={t('set.resetEditor')} hint={t('set.resetEditorHint')}><button type="button" onClick={()=>{if(confirm(t('set.resetEditorConfirm'))){st.resetEditor();toast('ok',t('set.editorReset'))}}}><RotateCcw size={16}/>{t('common.reset')}</button></Row>
   <Row title={t('set.drafts')} hint={t('set.draftsHint',{n:drafts.count,size:mb(drafts.bytes)})}><ActionButton className="danger" disabled={!drafts.count} onAction={async()=>{if(!confirm(t('set.draftsConfirm')))return;await clearAllDrafts();useSession.getState().clearAll();reloadStats()}} successText={t('set.draftsCleared')}><Trash2 size={16}/>{t('common.clear')}</ActionButton></Row>
  </>,
  models:<>
   <Row title={t('set.gpuModels')} hint={direct.models_updated_at?t('mod.listAt',{time:new Date(direct.models_updated_at).toLocaleString(locale)}):t('models.emptyList')}><b className="gold">{direct.models.length}</b></Row>
   <Row title={t('models.refresh')} hint={direct.url?'':t('set.needGpu')}><ActionButton disabled={!direct.url} onAction={async()=>{await direct.refresh(true);const s=useDirect.getState();if(s.models_error||s.state==='ERROR')throw Error(s.models_error||s.error)}} successText={t('models.refreshed')}><RotateCcw size={16}/>{t('models.refresh')}</ActionButton></Row>
   <Row title={t('set.library')} hint={t('set.libraryHint')}><Link href="/models" className="btn">{t('nav.models')}</Link></Row>
  </>,
  connections:<>
   <Row title={t('set.provider')}><b className="gold">{direct.provider==='colab'?'Google Colab':'CloudCompute'}</b><Link href="/engine" className="btn">{t('nav.gpu')}</Link></Row>
   <Switch label={t('set.showCc')} hint={t('set.showCcHint')} checked={ui.showCloudCompute} onChange={v=>{st.setUi({showCloudCompute:v});toast(v?'warn':'ok',v?t('set.ccOn'):t('set.ccOff'))}}/>
   {direct.provider==='cloudcompute'&&!ui.showCloudCompute&&<div className="notice tiny"><Warning size={14}/> {t('set.ccSelected')}</div>}
  </>,
  storage:<>
   <div className="notice infonotice tiny">{t('set.storageNote')}</div>
   <Row title={t('set.galleryCount')}><b className="gold">{images??'—'}</b></Row>
   <Row title={t('set.draftsSize')} hint={t('set.draftsWhere')}><b className="gold">{drafts.count} · {mb(drafts.bytes)}</b></Row>
   <Row title={t('set.settingsWhere')} hint={t('set.settingsWhereHint')}><b className="gold">Termux</b></Row>
  </>,
  gallery:<>
   <Row title={t('gal.exportMeta')} hint={t('set.metaHint')}><ActionButton onAction={async()=>{const items=await getImages();downloadJSON({version:1,items:items.map(({id,name,created,favorite,prompt,origin,type})=>({id,name,created,favorite,prompt,origin,type}))},'gallery-metadata.json')}} successText={t('gal.metaExported')}><Download size={16}/>JSON</ActionButton></Row>
   <Row title={t('set.clearGallery')} hint={t('set.clearGalleryHint')}><ActionButton className="danger" disabled={!images} onAction={async()=>{if(!confirm(t('set.clearGalleryConfirm')))return;await clearImages();reloadStats()}} successText={t('set.galleryCleared')}><Trash2 size={16}/>{t('common.clear')}</ActionButton></Row>
  </>,
  advanced:<>
   <Row title={t('set.diagnostics')} hint={t('set.diagnosticsHint')}><ActionButton onAction={async()=>setDiag(JSON.stringify(await localApi('/api/diagnostics'),null,1))}><Terminal size={16}/>{t('gpu.showLogs')}</ActionButton></Row>
   <Row title={t('set.resetUi')} hint={t('set.resetUiHint')}><button type="button" onClick={()=>{st.setUi({motion:'system',decor:'full',pixelText:false,largeText:false,showCloudCompute:false});toast('ok',t('set.saved'))}}><RotateCcw size={16}/>{t('common.reset')}</button></Row>
   <Row title={t('set.licenses')} hint="Onest, Tiny5, Press Start 2P (OFL-1.1) · Pixelarticons (MIT)"><a className="btn" href="/licenses/ONEST_OFL.txt" target="_blank" rel="noopener"><ExternalLink size={15}/>Onest</a><a className="btn" href="/licenses/TINY5_OFL.txt" target="_blank" rel="noopener"><ExternalLink size={15}/>Tiny5</a><a className="btn" href="/licenses/PRESS_START_2P_OFL.txt" target="_blank" rel="noopener"><ExternalLink size={15}/>PS2P</a><a className="btn" href="/licenses/PIXELARTICONS_MIT.txt" target="_blank" rel="noopener"><ExternalLink size={15}/>MIT</a></Row>
   <div className="row tiny muted" style={{gap:12}}><Mascot size={56} variant="avatar" alt={t('brand.mascot')}/><span>{t('set.mascotNote')}</span></div>
  </>,
 };
 return <div className="page stack"><PageHead icon={<Settings size={24}/>} title={t('nav.settings')} detail={t('set.detail')}/>
  <div className="settings-layout">
   <nav className="settings-nav" aria-label={t('nav.settings')}>{SECTIONS.map(([k,key,Icon])=><button type="button" key={k} aria-current={sec===k} onClick={()=>choose(k)}><Icon size={18}/>{t(key)}</button>)}</nav>
   <section className="panel stack" aria-label={t(SECTIONS.find(([k])=>k===sec)![1])} data-localized="true"><h2 className="h-spark">{t(SECTIONS.find(([k])=>k===sec)![1])}</h2>{body[sec]}</section>
  </div>
  {diag&&<Modal title={t('set.diagnostics')} onClose={()=>setDiag('')} wide><pre className="tiny card" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'60dvh',overflow:'auto',margin:0}}>{diag}</pre></Modal>}
 </div>;
}
