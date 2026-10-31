'use client';
// v1.9.0 PIXEL FANTASY gallery. Images are the user's real local gallery (/api/gallery, stored in Termux); the theme
// never alters them. Every action calls the existing API and reports the server's answer.
import {useCallback,useEffect,useMemo,useState} from 'react';
import {ImageUpload,downloadJSON,Tabs} from '@/components/Common';
import {type GalleryItem,getImages,addImage,deleteImage,downloadImage} from '@/lib/storage/gallery';
import {Download,Heart,Trash2,Copy,Search,MoreV,Images,Eye,Send,Paintbrush,Smile,Image as ImageIcon,ChevronLeft,ChevronRight,Save,CheckboxOn} from '@/components/icons';
import {PageHead,Modal,toast,copyText,EmptyState,ActionButton} from '@/components/ui';
import {useI18n} from '@/i18n';
import {useStudio,type EditorMode} from '@/stores/studio';
import {useSession} from '@/stores/session';
import {saveDraft,newImageId} from '@/lib/storage/drafts';
import {navigate} from '@/compat/navigation';
type Filter='all'|'favorites'|'generated'|'edits'|'imported';
const editModes=['img2img','inpaint','facefix'];
const modeOf=(x:GalleryItem)=>String((x.parameters as {mode?:string}|undefined)?.mode||'');
export default function Page(){
 const {t,locale}=useI18n();
 const [items,setItems]=useState<GalleryItem[]>([]),[loaded,setLoaded]=useState(false),[filter,setFilter]=useState<Filter>('all'),[query,setQuery]=useState(''),[viewer,setViewer]=useState<string|null>(null),[menu,setMenu]=useState<GalleryItem|null>(null),[error,setError]=useState(''),[selecting,setSelecting]=useState(false),[picked,setPicked]=useState<string[]>([]);
 const refresh=useCallback(()=>getImages().then(x=>{setItems(x.slice().sort((a,b)=>b.created-a.created));setError('');setLoaded(true)}).catch(()=>{setError(t('gal.openFailed'));setLoaded(true)}),[t]);
 useEffect(()=>{void refresh()},[refresh]);
 async function importFile(file:File){try{await addImage({id:crypto.randomUUID(),name:file.name,created:Date.now(),favorite:false,prompt:'',origin:'imported',type:file.type,blob:file});await refresh();toast('ok',t('gal.imported'))}catch(e){toast('bad',(e as Error).message||t('gal.saveFailed'))}}
 async function remove(ids:string[]){if(!ids.length||!confirm(ids.length===1?t('gal.deleteOne'):t('gal.deleteMany',{n:ids.length})))return;let ok=0;for(const id of ids){try{await deleteImage(id);ok++}catch{/* reported below */}}await refresh();setPicked([]);setViewer(v=>v&&ids.includes(v)?null:v);setMenu(null);if(ok===ids.length)toast('ok',t('gal.deleted',{n:ok}));else toast('bad',t('gal.deletePartial',{ok,n:ids.length}))}
 async function toggle(x:GalleryItem){try{await addImage({...x,blob:undefined,favorite:!x.favorite});await refresh();toast('ok',!x.favorite?t('gal.favAdded'):t('gal.favRemoved'))}catch(e){toast('bad',(e as Error).message)}}
 const counts=useMemo(()=>({all:items.length,favorites:items.filter(x=>x.favorite).length,generated:items.filter(x=>x.origin==='generated'&&!editModes.includes(modeOf(x))).length,edits:items.filter(x=>editModes.includes(modeOf(x))).length,imported:items.filter(x=>x.origin==='imported').length}),[items]);
 const visible=items.filter(x=>(filter==='all'||filter==='favorites'&&x.favorite||filter==='generated'&&x.origin==='generated'&&!editModes.includes(modeOf(x))||filter==='edits'&&editModes.includes(modeOf(x))||filter==='imported'&&x.origin==='imported')&&(`${x.name} ${x.prompt}`).toLowerCase().includes(query.trim().toLowerCase()));
 const current=viewer?items.find(x=>x.id===viewer)||null:null;
 const labels:Record<Filter,string>={all:t('gal.all'),favorites:t('gal.favorites'),generated:t('gal.generated'),edits:t('gal.edits'),imported:t('gal.importedTab')};
 return <div className="page stack"><PageHead icon={<Images size={24}/>} title={t('nav.gallery')} detail={t('gal.detail',{n:items.length})} right={<button type="button" className="pill" disabled={!items.length} onClick={()=>{downloadJSON({version:1,items:items.map(({id,name,created,favorite,prompt,origin,type})=>({id,name,created,favorite,prompt,origin,type}))},'gallery-metadata.json');toast('ok',t('gal.metaExported'))}}><Download size={15}/>{t('gal.exportMeta')}</button>}/>
  <Tabs options={['all','favorites','generated','edits','imported']} value={filter} onChange={v=>setFilter(v as Filter)} labels={Object.fromEntries(Object.entries(labels).map(([k,v])=>[k,`${v} ${counts[k as Filter]}`]))}/>
  <div className="row"><input className="grow" type="search" aria-label={t('gal.search')} placeholder={t('gal.search')} value={query} onChange={e=>setQuery(e.target.value)}/><Search size={20} className="gold"/></div>
  {error&&<div className="notice dangernotice" role="alert">{error}</div>}
  {!loaded?<p className="tiny muted">{t('common.loading')}</p>:visible.length===0?<section className="panel"><EmptyState title={items.length?t('gal.nothingFound'):t('gal.emptyTitle')} action={!items.length?<ImageUpload onFile={importFile} label={t('gal.import')}/>:undefined}>{items.length?t('gal.nothingFoundHint'):t('gal.emptyText')}</EmptyState></section>
   :<div className="gallerygrid">{visible.map(x=>{const on=picked.includes(x.id);return <div key={x.id} className={'gallerycard'+(on?' sel':'')}>
    <button type="button" className="g-open" aria-label={(selecting?t('gal.pick'):t('gal.open'))+': '+x.name} aria-pressed={selecting?on:undefined} onClick={()=>selecting?setPicked(p=>on?p.filter(i=>i!==x.id):[...p,x.id]):setViewer(x.id)}><img src={x.url||''} alt={x.name} loading="lazy"/></button>
    {selecting&&<span className="g-check" aria-hidden><input type="checkbox" readOnly checked={on} tabIndex={-1}/></span>}
    {!selecting&&<button type="button" className="g-menu" aria-label={t('gal.actions')+': '+x.name} onClick={()=>setMenu(x)}><MoreV size={18}/></button>}
    {!selecting&&<button type="button" className="g-fav" aria-label={x.favorite?t('gal.unfav'):t('gal.fav')} aria-pressed={x.favorite} onClick={()=>void toggle(x)}><Heart size={18} fill={x.favorite?'currentColor':'none'}/></button>}
    <span className="g-badge">{editModes.includes(modeOf(x))?modeOf(x):x.origin==='generated'?'GPU':t('gal.importBadge')}</span>
   </div>})}</div>}
  <div className="gallery-actions" data-localized="true">
   <button type="button" aria-pressed={selecting} onClick={()=>{setSelecting(!selecting);setPicked([])}}><CheckboxOn size={16}/>{selecting?t('gal.done'):t('gal.select')}</button>
   <button type="button" className="icon danger" aria-label={t('gal.deleteSelected',{n:picked.length})} title={t('gal.deleteSelected',{n:picked.length})} disabled={!picked.length} onClick={()=>void remove(picked)}><Trash2 size={18}/>{picked.length?picked.length:''}</button>
   <ImageUpload onFile={importFile} label={t('gal.import')}/>
  </div>
  {menu&&<ContextMenu item={menu} onClose={()=>setMenu(null)} onOpen={()=>{setViewer(menu.id);setMenu(null)}} onToggle={()=>void toggle(menu).then(()=>setMenu(null))} onDelete={()=>void remove([menu.id])} locale={locale}/>}
  {current&&<Viewer item={current} list={visible} onNavigate={setViewer} onClose={()=>setViewer(null)} onToggle={()=>void toggle(current)} onDelete={()=>void remove([current.id])} onSaved={refresh} locale={locale}/>}
 </div>;
}
/** Sends a gallery image to an editor slot through the same draft mechanism the editor uses. */
async function openInEditor(item:GalleryItem,mode:EditorMode){
 const blob=await (await fetch(item.url||'')).blob();const file=new File([blob],item.name,{type:item.type||blob.type});const imageId=newImageId();const s=useSession.getState();
 if(mode==='IMG2IMG'){await saveDraft('img2img',imageId,file,item.name);s.setSource('img2img',{file,imageId,restored:true})}
 else if(mode==='INPAINT'){await saveDraft('inpaint',imageId,file,item.name,{strokes:[],box:null,job:null});s.setCanvas('inpaint',{img:null,strokes:[],redo:[],box:null,job:null,restored:false})}
 else{await saveDraft('facefix',imageId,file,item.name,{detection:null,selected:[],manual:false,box:null,job:null,result:''});s.setFaceFix({img:null,detection:null,selected:[],manual:false,box:null,job:null,result:'',restored:false})}
 useStudio.getState().setEditor({mode,classic:false});navigate('/edit');
}
function useFileInfo(item:GalleryItem){const [info,setInfo]=useState<{w:number;h:number;size:number}|null>(null);useEffect(()=>{let live=true;setInfo(null);fetch(item.url||'').then(r=>r.blob()).then(async b=>{const bm=await createImageBitmap(b);if(live)setInfo({w:bm.width,h:bm.height,size:b.size});bm.close()}).catch(()=>{});return()=>{live=false}},[item.url]);return info}
const kb=(n:number)=>n>1048576?(n/1048576).toFixed(1)+' MB':Math.round(n/1024)+' KB';
function ContextMenu({item,onClose,onOpen,onToggle,onDelete,locale}:{item:GalleryItem;onClose:()=>void;onOpen:()=>void;onToggle:()=>void;onDelete:()=>void;locale:string}){
 const {t}=useI18n();const info=useFileInfo(item);
 const canShare=typeof navigator!=='undefined'&&!!navigator.share&&!!navigator.canShare;
 const share=async()=>{const blob=await (await fetch(item.url||'')).blob();const file=new File([blob],item.name,{type:item.type||blob.type});if(!navigator.canShare?.({files:[file]}))throw Error(t('gal.shareUnsupported'));await navigator.share({files:[file],title:item.name}).catch(e=>{if((e as Error).name!=='AbortError')throw e})};
 return <Modal title={t('gal.menuTitle')} onClose={onClose}>
  <div className="row ctx-menu" style={{gap:12,alignItems:'flex-start'}}><img src={item.url||''} alt="" style={{width:88,height:88,objectFit:'cover',boxShadow:'0 0 0 2px var(--gold-deep)'}}/><div className="tiny stack" style={{gap:3,minWidth:0}}><b style={{overflowWrap:'anywhere'}}>{item.name}</b><span className="muted">{(item.type||'').replace('image/','').toUpperCase()}{info?` · ${info.w}×${info.h} · ${kb(info.size)}`:''}</span><span className="muted">{new Date(item.created).toLocaleString(locale)}</span></div></div>
  <div className="px-list ctx-menu" role="menu">
   <button type="button" role="menuitem" className="px-row" onClick={onOpen}><Eye size={20}/>{t('gal.open')}</button>
   <ActionButton role="menuitem" className="px-row" disabled={!item.prompt} onAction={()=>copyText(item.prompt,t('toast.promptCopied'),t('toast.copyFailed'))}><Copy size={20}/>{t('gal.copyPrompt')}</ActionButton>
   {canShare&&<ActionButton role="menuitem" className="px-row" onAction={share}><Send size={20}/>{t('gal.share')}</ActionButton>}
   <button type="button" role="menuitem" className="px-row" onClick={onToggle}><Heart size={20} fill={item.favorite?'currentColor':'none'}/>{item.favorite?t('gal.unfav'):t('gal.fav')}</button>
   <button type="button" role="menuitem" className="px-row" onClick={()=>{downloadImage(item);toast('ok',t('gal.downloadStarted'))}}><Download size={20}/>{t('gal.download')}</button>
   <ActionButton role="menuitem" className="px-row" onAction={()=>openInEditor(item,'INPAINT')}><Paintbrush size={20}/>{t('gal.toInpaint')}</ActionButton>
   <ActionButton role="menuitem" className="px-row" onAction={()=>openInEditor(item,'IMG2IMG')}><ImageIcon size={20}/>{t('gal.toImg2Img')}</ActionButton>
   <ActionButton role="menuitem" className="px-row" onAction={()=>openInEditor(item,'FACE FIX')}><Smile size={20}/>{t('gal.toFaceFix')}</ActionButton>
   <button type="button" role="menuitem" className="px-row danger" onClick={onDelete}><Trash2 size={20}/>{t('common.delete')}</button>
  </div>
 </Modal>;
}
function Viewer({item,list,onNavigate,onClose,onToggle,onDelete,onSaved,locale}:{item:GalleryItem;list:GalleryItem[];onNavigate:(id:string)=>void;onClose:()=>void;onToggle:()=>void;onDelete:()=>void;onSaved:()=>Promise<unknown>;locale:string}){
 const {t}=useI18n();const [notes,setNotes]=useState(item.prompt);const info=useFileInfo(item);useEffect(()=>setNotes(item.prompt),[item.id,item.prompt]);
 const i=list.findIndex(x=>x.id===item.id);const prev=i>0?list[i-1]:null,next=i>=0&&i<list.length-1?list[i+1]:null;
 const p=(item.parameters||{}) as Record<string,unknown>;
 const rows:[string,string][]=[[t('gal.mDate'),new Date(item.created).toLocaleString(locale)],[t('gal.mOrigin'),item.origin==='generated'?t('gal.mGenerated'):t('gal.importBadge')],[t('gal.mFile'),`${(item.type||'').replace('image/','').toUpperCase()}${info?` · ${info.w}×${info.h} · ${kb(info.size)}`:''}`]];
 if(p.mode)rows.push([t('gal.mMode'),String(p.mode)]);if(item.seed!=null)rows.push(['Seed',String(item.seed)]);
 if(p.steps!=null)rows.push([t('params.steps'),String(p.steps)]);if(p.cfg_scale!=null)rows.push(['CFG',String(p.cfg_scale)]);if(p.sampler)rows.push(['Sampler',`${p.sampler} · ${p.scheduler??''}`]);
 if(p.width)rows.push([t('gal.mSize'),`${p.width}×${p.height}`]);if(Array.isArray(p.lora_adapters)&&p.lora_adapters.length)rows.push(['LoRA',String(p.lora_adapters.length)]);
 if(typeof p.negative_prompt==='string'&&p.negative_prompt)rows.push([t('prompt.negative'),p.negative_prompt]);
 return <Modal title={item.name} onClose={onClose} wide label={t('gal.viewer')}>
  <div className="viewer stack"><img src={item.url||''} alt={item.name}/>
   <div className="grid3"><button type="button" disabled={!prev} onClick={()=>prev&&onNavigate(prev.id)} aria-label={t('gal.prev')}><ChevronLeft size={18}/></button><span className="tiny muted" style={{alignSelf:'center',textAlign:'center'}}>{i+1} / {list.length}</span><button type="button" disabled={!next} onClick={()=>next&&onNavigate(next.id)} aria-label={t('gal.next')}><ChevronRight size={18}/></button></div>
   <dl className="meta-list">{rows.flatMap(([k,v])=>[<dt key={k+'k'}>{k}</dt>,<dd key={k+'v'}>{v}</dd>])}</dl>
   <div className="field"><label>{item.origin==='generated'?t('gal.promptNotes'):t('gal.notes')}</label><textarea value={notes} onChange={e=>setNotes(e.target.value)} rows={4}/></div>
   <div className="row">
    <ActionButton disabled={notes===item.prompt} onAction={async()=>{await addImage({...item,blob:undefined,prompt:notes});await onSaved()}} successText={t('gal.notesSaved')}><Save size={16}/>{t('common.save')}</ActionButton>
    <button type="button" disabled={!notes} onClick={()=>void copyText(notes,t('toast.promptCopied'),t('toast.copyFailed'))}><Copy size={16}/>{t('gal.copyPrompt')}</button>
    <button type="button" onClick={()=>{downloadImage(item);toast('ok',t('gal.downloadStarted'))}}><Download size={16}/>{t('gal.download')}</button>
    <button type="button" aria-pressed={item.favorite} onClick={onToggle}><Heart size={16} fill={item.favorite?'currentColor':'none'}/>{item.favorite?t('gal.unfav'):t('gal.fav')}</button>
    <button type="button" className="danger" onClick={onDelete}><Trash2 size={16}/>{t('common.delete')}</button>
   </div>
  </div>
 </Modal>;
}
