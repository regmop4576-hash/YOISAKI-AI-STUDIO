'use client';
// v1.9.0 PIXEL FANTASY editor. Same Img2Img / Inpaint / Face Fix pipelines as v1.8.1.
// State fix: the mode and every working parameter live in the persisted studio store; the loaded image, mask strokes,
// face box and last job live in the session store and in an IndexedDB draft bound to the image id. Leaving for the
// Gallery and coming back (or reloading) restores the same work; loading another image resets strokes and boxes.
import {useEffect,useMemo,useRef,useState} from 'react';
import {Stage,Layer,Image as KImage,Line,Rect,Transformer} from 'react-konva';
import {maskCanvas,normalizedImage,boundedBox,sourcePoint,type EditorInput,type Stroke} from '@/lib/editor';
import {Tabs,ImageUpload,Slider,downloadJSON} from './Common';
import {GenerationControls,DirectImage,TERMINAL,type LiveJob} from './Generator';
import {useStudio,type EditorMode} from '@/stores/studio';
import {useSession,type CanvasSlot} from '@/stores/session';
import {downloadBlob} from '@/lib/storage/gallery';
import {imageFromDirect,useDirect} from '@/lib/engine/direct';
import {saveDraft,loadDraft,clearDraft,newImageId,draftDataWriter} from '@/lib/storage/drafts';
import {FaceFix} from './FaceFix';
import {Paintbrush,Eraser,Move,ZoomIn,ZoomOut,RotateCcw,Undo,Redo,Trash2,Download,Crop,Image as ImageIcon,Smile,ChevronLeft} from './icons';
import {PageHead,SectionTitle,toast,EmptyState} from './ui';
import {useI18n} from '@/i18n';
type Box={x:number;y:number;width:number;height:number};
type CanvasData={strokes:Stroke[];box:Box|null;job:LiveJob|null};
export function Editor(){
 const {t}=useI18n();const mode=useStudio(s=>s.editor.mode),classic=useStudio(s=>s.editor.classic),setEditor=useStudio(s=>s.setEditor);
 const job=useSession(s=>s.jobs.img2img),setJob=useSession(s=>s.setJob);
 return <div className="page stack"><PageHead icon={<Paintbrush size={24}/>} title={t('nav.editor')} detail={t('editor.detail')}/>
  <Tabs value={mode} onChange={v=>setEditor({mode:v as EditorMode,classic:false})} options={['INPAINT','IMG2IMG','FACE FIX']} fit labels={{INPAINT:<><Paintbrush size={15}/>Inpaint</>,IMG2IMG:<><ImageIcon size={15}/>Img2Img</>,'FACE FIX':<><Smile size={15}/>Face Fix</>}}/>
  {mode==='IMG2IMG'?<div className="generator"><GenerationControls currentJob={job} setCurrentJob={j=>setJob('img2img',j)} lockedMode="img2img"/><div className="gen-side"><Img2ImgOutput job={job}/></div></div>
   :mode==='FACE FIX'&&!classic?<FaceFix onClassic={()=>setEditor({classic:true})}/>
   :<>{mode==='FACE FIX'&&<button type="button" className="pill" style={{alignSelf:'flex-start'}} onClick={()=>setEditor({classic:false})}><ChevronLeft size={15}/>Smart Face Fix</button>}<CanvasEditor key={mode} mode={mode==='INPAINT'?'mask':'face'}/></>}
 </div>;
}
function Img2ImgOutput({job}:{job:LiveJob|null}){const {t,tv}=useI18n();const s=useStudio(x=>x.settings);const source=useSession(x=>x.img2img.file);const done=job?.status==='COMPLETED'&&!!job.result?.image_keys?.length;const [result,setResult]=useState('');const before=useMemo(()=>source?URL.createObjectURL(source):'',[source]);useEffect(()=>()=>{if(before)URL.revokeObjectURL(before)},[before]);
 useEffect(()=>{setResult('');if(!done)return;let live=true;imageFromDirect('','',job!.id,0).then(u=>{if(live)setResult(u)}).catch(()=>{});return()=>{live=false}},[done,job?.id]);// eslint-disable-line react-hooks/exhaustive-deps
 return <section className="panel stack"><SectionTitle icon={<ImageIcon size={20}/>}>{t('editor.i2iResult')}</SectionTitle><p className="tiny muted">{t('editor.i2iHint')}</p>
  {done&&result&&before?<BeforeAfter before={before} after={result} ratio={`${s.width}/${s.height}`}/>:<div className="preview" style={{aspectRatio:`${Math.max(1,s.width)}/${Math.max(1,s.height)}`,maxHeight:560}}>{done?<DirectImage job={job!.id} index={0} preview/>:<div className="placeholder"><p className="subtle">{job?.status?t('gen.taskStatus',{s:tv('status',job.status)}):t('editor.i2iEmpty')}</p></div>}</div>}
  {done&&<DirectImage job={job!.id} index={0}/>}</section>}
/** Before / after comparison; both images are fitted the same way so the divider lines up. */
export function BeforeAfter({before,after,ratio}:{before:string;after:string;ratio?:string}){const {t}=useI18n();const [pos,setPos]=useState(50);return <div className="stack" style={{gap:6}}><div className="ba-wrap" style={{aspectRatio:ratio}}><img src={before} alt={t('editor.before')} style={{width:'100%',height:'100%',objectFit:'contain'}}/><img className="ba-after" src={after} alt={t('editor.after')} style={{clipPath:`inset(0 0 0 ${pos}%)`}}/><div className="ba-line" style={{left:pos+'%'}}/><div className="ba-tags"><span>{t('editor.before')}</span><span>{t('editor.after')}</span></div></div><Slider label="Before / After" caption={t('editor.compare')} min={0} max={100} step={1} value={pos} onChange={setPos}/></div>}
const writers={inpaint:draftDataWriter('inpaint'),facebox:draftDataWriter('facebox')};
function CanvasEditor({mode}:{mode:'mask'|'face'}){
 const {t}=useI18n();const slot=mode==='mask'?'inpaint':'facebox';
 const st=useSession(s=>s[slot]) as CanvasSlot;const setSlot=useSession(s=>s.setCanvas);const set=(p:Partial<CanvasSlot>|((s:CanvasSlot)=>Partial<CanvasSlot>))=>setSlot(slot,p);
 const ip=useStudio(s=>s.editor.inpaint),fr=useStudio(s=>s.editor.faceRegion),setInpaint=useStudio(s=>s.setInpaint),setFaceRegion=useStudio(s=>s.setFaceRegion);
 const image=st.img?.image||null,name=st.img?.name||'',strokes=st.strokes,redo=st.redo,box=st.box,job=st.job;
 const brush=ip.brush,erase=ip.erase,denoise=mode==='mask'?ip.denoise:fr.denoise,padding=mode==='mask'?ip.padding:fr.padding,blur=mode==='mask'?ip.blur:fr.blur,regionMode=ip.regionMode;
 const setDenoise=(v:number)=>mode==='mask'?setInpaint({denoise:v}):setFaceRegion({denoise:v});const setPadding=(v:number)=>mode==='mask'?setInpaint({padding:v}):setFaceRegion({padding:v});const setBlur=(v:number)=>mode==='mask'?setInpaint({blur:v}):setFaceRegion({blur:v});
 const [tool,setTool]=useState<'draw'|'pan'>('draw');const [zoom,setZoom]=useState(1),[pan,setPan]=useState({x:0,y:0}),[status,setStatus]=useState(''),[result,setResult]=useState('');
 const uploadRevision=useRef(0);const painting=useRef(false),start=useRef({x:0,y:0}),panStart=useRef<{x:number;y:number;px:number;py:number}|null>(null),wrap=useRef<HTMLDivElement>(null),stage=useRef<any>(null),transformer=useRef<any>(null);const [containerWidth,setWidth]=useState(600);
 // Restore once per app session from the IndexedDB draft (data is bound to the stored image id).
 useEffect(()=>{if(st.restored)return;set({restored:true});const revision=uploadRevision.current;void loadDraft<CanvasData>(slot).then(async d=>{if(!d||revision!==uploadRevision.current||useSession.getState()[slot].img)return;try{const img=await normalizedImage(new File([d.blob],d.name,{type:d.type}));if(revision!==uploadRevision.current)return;set({img:{imageId:d.imageId,name:d.name,image:img,file:d.blob},strokes:d.data?.strokes||[],redo:[],box:d.data?.box||null,job:d.data?.job||null});toast('info',t('editor.restored'))}catch{void clearDraft(slot)}})},[]);// eslint-disable-line react-hooks/exhaustive-deps
 // Persist mask / box / job for the current image only.
 useEffect(()=>{if(st.img)writers[slot](st.img.imageId,{strokes,box,job})},[strokes,box,job,st.img,slot]);
 useEffect(()=>{if(!wrap.current)return;const obs=new ResizeObserver(entries=>setWidth(Math.max(200,entries[0].contentRect.width)));obs.observe(wrap.current);return()=>obs.disconnect()},[!!image]);// eslint-disable-line react-hooks/exhaustive-deps
 useEffect(()=>{if(transformer.current&&stage.current){const node=stage.current.findOne('#face-region');if(node){transformer.current.nodes([node]);transformer.current.getLayer()?.batchDraw()}}},[box,zoom,pan]);
 useEffect(()=>{setResult('');const done=job?.status==='COMPLETED'&&job.result?.image_keys?.length;if(!done)return;let live=true;imageFromDirect('','',job!.id,0).then(u=>{if(live)setResult(u)}).catch(()=>{});return()=>{live=false}},[job?.id,job?.status]);// eslint-disable-line react-hooks/exhaustive-deps
 const setJob=(j:LiveJob|null)=>set({job:j});
 const onFile=async(f:File)=>{const revision=++uploadRevision.current;try{const img=await normalizedImage(f);if(revision!==uploadRevision.current)return;const imageId=newImageId();set({img:{imageId,name:f.name,image:img,file:f},strokes:[],redo:[],box:null,job:null});setPan({x:0,y:0});setZoom(1);setStatus('');void saveDraft(slot,imageId,f,f.name,{strokes:[],box:null,job:null}).catch(()=>toast('warn',t('draft.notSaved')))}catch(e){setStatus((e as Error).message)}};
 const editorInput=async():Promise<EditorInput>=>{if(!image)throw Error(t('editor.needImage'));if(mode==='face'&&(!box||box.width<2||box.height<2))throw Error(t('editor.needFaceBox'));if(mode==='mask'&&!strokes.some(s=>!s.erase))throw Error(t('editor.needMask'));const mask=mode==='mask'?maskCanvas(image.width,image.height,strokes).toDataURL('image/png'):undefined;if(mask&&mask.length>8*1024*1024)throw Error(t('editor.maskTooLarge'));return {init_image:image.src,denoising_strength:denoise,mask_blur:blur,mask_padding:padding,inpaint_region:mode==='face'?'crop':regionMode,...(mask?{mask_image:mask}:{face_region:box!})}};
 const facePreview=useMemo(()=>{if(!image||!box)return '';const c=document.createElement('canvas');c.width=256;c.height=256;const ctx=c.getContext('2d')!;const b=boundedBox(box,image.width,image.height),r=Math.min(256/b.width,256/b.height);ctx.drawImage(image,b.x,b.y,b.width,b.height,(256-b.width*r)/2,(256-b.height*r)/2,b.width*r,b.height*r);return c.toDataURL('image/png')},[image,box]);
 const fit=image?Math.min(containerWidth/image.width,440/image.height,1):1;const stageW=containerWidth,stageH=image?Math.min(520,Math.max(240,image.height*fit+24)):0;const imgW=image?image.width*fit:0,imgH=image?image.height*fit:0;const originX=(stageW-imgW)/2,originY=(stageH-imgH)/2;
 function pos(){const s=stage.current;if(!s||!image)return null;const pt=s.getPointerPosition();if(!pt)return null;return sourcePoint(pt.x,pt.y,originX+pan.x,originY+pan.y,fit*zoom,image.width,image.height)}
 function down(e:any){if(!image)return;e.evt.preventDefault?.();if(e.evt.button===2)return;if(tool==='pan'){const pt=stage.current?.getPointerPosition();if(pt)panStart.current={x:pt.x,y:pt.y,px:pan.x,py:pan.y};return}const p=pos();if(!p)return;if(mode==='mask'){painting.current=true;set(s=>({redo:[],strokes:[...s.strokes,{points:[p.x,p.y,p.x+.001,p.y+.001],size:brush,erase}]}))}else if(e.target===stage.current){painting.current=true;start.current=p;set({box:{x:p.x,y:p.y,width:1,height:1}})}}
 function move(){if(panStart.current){const pt=stage.current?.getPointerPosition();if(pt){const a=panStart.current;setPan({x:a.px+pt.x-a.x,y:a.py+pt.y-a.y})}return}if(!painting.current||!image)return;const p=pos();if(!p)return;if(mode==='mask')set(s=>({strokes:s.strokes.map((x,i)=>i===s.strokes.length-1?{...x,points:[...x.points,p.x,p.y]}:x)}));else set({box:{x:Math.min(start.current.x,p.x),y:Math.min(start.current.y,p.y),width:Math.abs(p.x-start.current.x),height:Math.abs(p.y-start.current.y)}})}
 function end(){painting.current=false;panStart.current=null}
 const undo=()=>set(s=>s.strokes.length?{redo:[...s.redo,s.strokes[s.strokes.length-1]],strokes:s.strokes.slice(0,-1)}:{});
 const redoAct=()=>set(s=>s.redo.length?{strokes:[...s.strokes,s.redo[s.redo.length-1]],redo:s.redo.slice(0,-1)}:{});
 const clear=()=>{if(mode==='mask'){if(strokes.length&&!confirm(t('editor.clearConfirm')))return;set({strokes:[],redo:[]})}else set({box:null})};
 function exportMask(){if(!image){setStatus(t('editor.needImage'));return}maskCanvas(image.width,image.height,strokes).toBlob(b=>{if(b){downloadBlob(b,'yoisaki-mask.png');toast('ok',t('editor.maskSaved'))}},'image/png')}
 function exportFace(){if(!image||!box||box.width<2||box.height<2){setStatus(t('editor.needFaceBox'));return}downloadJSON({version:1,image:{name,width:image.width,height:image.height},region:{...box,padding,denoise},autoDetection:false},'face-region.json');toast('ok',t('editor.regionSaved'))}
 const zoomBy=(f:number)=>setZoom(z=>Math.max(.5,Math.min(4,Math.round(z*f*10)/10)));
 const drawTool=mode==='mask'?(erase?'eraser':'brush'):'region';
 const rail=<div className="tool-rail" role="toolbar" aria-label={t('editor.tools')} aria-orientation="vertical">
  {mode==='mask'?<><button type="button" aria-label={t('editor.brush')} title={t('editor.brush')} aria-pressed={tool==='draw'&&drawTool==='brush'} onClick={()=>{setTool('draw');setInpaint({erase:false})}}><Paintbrush size={22}/></button>
   <button type="button" aria-label={t('editor.eraser')} title={t('editor.eraser')} aria-pressed={tool==='draw'&&drawTool==='eraser'} onClick={()=>{setTool('draw');setInpaint({erase:true})}}><Eraser size={22}/></button></>
   :<button type="button" aria-label={t('editor.selectFace')} title={t('editor.selectFace')} aria-pressed={tool==='draw'} onClick={()=>setTool('draw')}><Crop size={22}/></button>}
  <button type="button" aria-label={t('editor.pan')} title={t('editor.pan')} aria-pressed={tool==='pan'} onClick={()=>setTool('pan')}><Move size={22}/></button>
  <button type="button" aria-label={t('editor.zoomIn')} title={t('editor.zoomIn')} disabled={!image||zoom>=4} onClick={()=>zoomBy(1.25)}><ZoomIn size={22}/></button>
  <button type="button" aria-label={t('editor.zoomOut')} title={t('editor.zoomOut')} disabled={!image||zoom<=.5} onClick={()=>zoomBy(.8)}><ZoomOut size={22}/></button>
  <button type="button" aria-label={t('editor.resetView')} title={t('editor.resetView')} disabled={!image} onClick={()=>{setZoom(1);setPan({x:0,y:0})}}><RotateCcw size={22}/></button>
  {mode==='mask'&&<button type="button" aria-label={t('editor.exportMask')} title={t('editor.exportMask')} disabled={!image} onClick={exportMask}><Download size={22}/></button>}
 </div>;
 const busy=!!job&&!TERMINAL.includes(job.status);
 return <div className="editor-layout stack"><section className="panel stack" data-localized="true">
  <div className="row"><ImageUpload onFile={onFile} label={image?t('editor.replace'):t('editor.upload')}/><span className="tiny muted grow" style={{overflowWrap:'anywhere'}}>{image?`${image.width} × ${image.height} · ${name}`:t('editor.formats')}</span>{image&&<button type="button" className="pill" onClick={async()=>downloadBlob(await (await fetch(image.src)).blob(),'yoisaki-original.png')}><Download size={15}/>{t('editor.downloadSource')}</button>}</div>
  <div className="editor-shell">{rail}<div ref={wrap} className={image?'editorcanvas':'editorcanvas editorcanvas-empty'} data-testid="editor-canvas" style={{cursor:tool==='pan'?'grab':mode==='mask'?'crosshair':'crosshair'}}>
   {image&&<div className="canvas-toolbar">{mode==='mask'&&<><button type="button" aria-label={t('editor.undo')} title={t('editor.undo')} disabled={!strokes.length} onClick={undo}><Undo size={18}/></button><button type="button" aria-label={t('editor.redo')} title={t('editor.redo')} disabled={!redo.length} onClick={redoAct}><Redo size={18}/></button></>}</div>}
   {image&&<Stage ref={stage} width={stageW} height={stageH} onMouseDown={down} onTouchStart={down} onMouseMove={move} onTouchMove={move} onMouseUp={end} onTouchEnd={end} onTouchCancel={end} onMouseLeave={end} style={{touchAction:'none'}}><Layer><KImage image={image} x={originX+pan.x} y={originY+pan.y} width={imgW*zoom} height={imgH*zoom} listening={false}/></Layer><Layer clipX={originX+pan.x} clipY={originY+pan.y} clipWidth={imgW*zoom} clipHeight={imgH*zoom}>{mode==='mask'&&strokes.map((s,i)=><Line key={i} x={originX+pan.x} y={originY+pan.y} points={s.points.map(p=>p*fit*zoom)} stroke="rgba(255,170,40,.65)" lineCap="round" lineJoin="round" strokeWidth={s.size*fit*zoom} globalCompositeOperation={s.erase?'destination-out':'source-over'} listening={false}/>)}{mode==='face'&&box&&<><Rect id="face-region" x={originX+pan.x+box.x*fit*zoom} y={originY+pan.y+box.y*fit*zoom} width={box.width*fit*zoom} height={box.height*fit*zoom} stroke="#ffc247" strokeWidth={2} dash={[6,4]} fill="rgba(255,152,0,.12)" draggable={tool==='draw'} onDragEnd={e=>{if(!box)return;const next=boundedBox({...box,x:(e.target.x()-originX-pan.x)/(fit*zoom),y:(e.target.y()-originY-pan.y)/(fit*zoom)},image.width,image.height);e.target.position({x:originX+pan.x+next.x*fit*zoom,y:originY+pan.y+next.y*fit*zoom});set({box:next})}} onTransformEnd={e=>{const n=e.target;set({box:boundedBox({x:(n.x()-originX-pan.x)/(fit*zoom),y:(n.y()-originY-pan.y)/(fit*zoom),width:Math.abs(n.width()*n.scaleX()/(fit*zoom)),height:Math.abs(n.height()*n.scaleY()/(fit*zoom))},image.width,image.height)});n.scale({x:1,y:1})}}/><Transformer ref={transformer} rotateEnabled={false} flipEnabled={false} keepRatio={false} anchorFill="#ffc247" anchorStroke="#2a1302" anchorSize={12} borderStroke="#ffc247" boundBoxFunc={(old,b)=>Math.abs(b.width)<8||Math.abs(b.height)<8?old:b} enabledAnchors={['top-left','top-right','bottom-left','bottom-right','middle-left','middle-right','top-center','bottom-center']}/></>}</Layer></Stage>}
   {!image&&<div className="empty-editor"><EmptyState title={t('editor.emptyTitle')}>{t('editor.emptyText')}</EmptyState></div>}
  </div></div>
  {mode==='mask'?<><Slider label="Brush diameter (source pixels)" caption={t('editor.brushSize')} min={2} max={250} step={1} value={brush} onChange={v=>setInpaint({brush:v})}/><Slider label="Denoise strength" caption={t('editor.strength')} min={.05} max={1} step={.05} value={denoise} onChange={setDenoise}/></>
   :<><Slider label="Face-region padding" caption={t('editor.facePadding')} min={0} max={1} step={.05} value={padding} onChange={setPadding}/><Slider label="Denoise strength" caption={t('editor.strength')} min={.05} max={1} step={.05} value={denoise} onChange={setDenoise}/>{facePreview&&<img src={facePreview} alt={t('editor.faceAlt')} style={{width:140,height:140,objectFit:'contain',alignSelf:'center',background:'#000'}}/>}<div className="tiny muted">{t('editor.faceTip')}</div></>}
  <div className="grid3">{mode==='mask'?<><button type="button" disabled={!strokes.length} onClick={undo}><Undo size={16}/>{t('editor.undo')}</button><button type="button" disabled={!redo.length} onClick={redoAct}><Redo size={16}/>{t('editor.redo')}</button><button type="button" className="danger" disabled={!strokes.length} onClick={clear}><Trash2 size={16}/>{t('common.clear')}</button></>:<><button type="button" disabled={!box} onClick={clear}><Trash2 size={16}/>{t('common.clear')}</button><button type="button" disabled={!box} onClick={exportFace}><Download size={16}/>JSON</button><span/></>}</div>
  <div className="notice infonotice tiny">{mode==='mask'?t('editor.maskHint'):t('editor.faceHint')}</div>
  <details><summary>{t('editor.advanced')}</summary><div className="stack" style={{marginTop:6}}>
   {mode==='mask'&&<><Slider label="Mask context padding" caption={t('editor.maskPadding')} min={0} max={1} step={.05} value={padding} onChange={setPadding}/><label className="field">{t('editor.region')}<select aria-label={t('editor.region')} value={regionMode} onChange={e=>setInpaint({regionMode:e.target.value as 'crop'|'full'})}><option value="crop">{t('editor.regionCrop')}</option><option value="full">{t('editor.regionFull')}</option></select></label><button type="button" onClick={exportMask} disabled={!image}><Download size={16}/>{t('editor.exportMask')}</button></>}
   <Slider label="Mask feather (source pixels)" caption={t('editor.feather')} min={0} max={64} step={1} value={blur} onChange={setBlur}/>
  </div></details>
  {status&&<div role="status" className="notice dangernotice">{status}</div>}
  {job?.status==='COMPLETED'&&result&&image&&<div className="stack"><SectionTitle icon={<ImageIcon size={20}/>}>{t('editor.result')}</SectionTitle><BeforeAfter before={image.src} after={result} ratio={`${image.width}/${image.height}`}/><div className="row"><a className="btn primary" href={result} download={`yoisaki-${mode==='mask'?'inpaint':'facefix'}-${job.id}.png`}><Download size={16}/>{t('editor.saveResult')}</a><button type="button" onClick={()=>set({job:null})}>{t('editor.keepOriginal')}</button></div><span className="tiny muted">{t('editor.savedToGallery')}</span></div>}
  {busy&&<p className="tiny muted" role="status">{t('editor.working')}</p>}
 </section>
 <div className="gen-side"><GenerationControls currentJob={job} setCurrentJob={setJob} lockedMode={mode==='mask'?'inpaint':'facefix'} editorInput={editorInput}/></div></div>;
}
