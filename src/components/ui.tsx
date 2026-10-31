'use client';
// v1.9.0 PIXEL FANTASY · shared building blocks. Every visual state here mirrors a real state: a button shows
// "loading" only while its promise runs, "success" only after it resolved, "error" only after it rejected.
import {useEffect,useRef,useState,useCallback,type ReactNode,type CSSProperties,type ButtonHTMLAttributes} from 'react';
import {create} from 'zustand';
import {X} from './icons';
import {useI18n} from '@/i18n';
import {useDirect,type DirectStatus} from '@/lib/engine/direct';
import {useStudio} from '@/stores/studio';
/** CloudCompute stays hidden for public users until enabled in Settings: it has not passed real GPU tests (v1.7.7.1 report). */
export function useCloudComputeVisible(){const shown=useStudio(s=>s.ui.showCloudCompute);const provider=useDirect(x=>x.provider);return shown||provider==='cloudcompute'}

/* ---------- toasts ---------- */
type Tone='ok'|'warn'|'bad'|'info';
type Toast={id:number;tone:Tone;text:string};
const useToasts=create<{items:Toast[];push:(tone:Tone,text:string)=>void;drop:(id:number)=>void}>(set=>({items:[],
 push:(tone,text)=>{const id=Date.now()+Math.random();set(s=>({items:[...s.items.slice(-2),{id,tone,text}]}));setTimeout(()=>set(s=>({items:s.items.filter(t=>t.id!==id)})),tone==='bad'?6000:3200)},
 drop:id=>set(s=>({items:s.items.filter(t=>t.id!==id)}))}));
export const toast=(tone:Tone,text:string)=>useToasts.getState().push(tone,text);
export function Toasts(){const items=useToasts(s=>s.items),drop=useToasts(s=>s.drop);return <div className="toast-wrap" aria-live="polite">{items.map(t=><div key={t.id} role={t.tone==='bad'?'alert':'status'} className={'toast notice '+(t.tone==='bad'?'dangernotice':t.tone==='ok'?'oknotice':t.tone==='info'?'infonotice':'')} onClick={()=>drop(t.id)}>{t.text}</div>)}</div>}

/* ---------- async action button ---------- */
export type ActionState='idle'|'loading'|'success'|'error';
export function useAction<A extends unknown[]>(fn:(...a:A)=>Promise<unknown>|unknown,{successMs=1400,onError}:{successMs?:number;onError?:(e:Error)=>void}={}){
 const [state,setState]=useState<ActionState>('idle');const alive=useRef(true);const timer=useRef<ReturnType<typeof setTimeout>>(undefined);
 useEffect(()=>()=>{alive.current=false;clearTimeout(timer.current)},[]);
 const run=useCallback(async(...a:A)=>{clearTimeout(timer.current);setState('loading');try{const r=await fn(...a);if(alive.current){setState('success');timer.current=setTimeout(()=>alive.current&&setState('idle'),successMs)}return r}catch(e){if(alive.current){setState('error');timer.current=setTimeout(()=>alive.current&&setState('idle'),2400)}onError?.(e as Error);return undefined}},[fn,successMs,onError]);
 return [state,run] as const;
}
type AB=Omit<ButtonHTMLAttributes<HTMLButtonElement>,'onClick'>&{onAction:()=>Promise<unknown>|unknown;children:ReactNode;errorToast?:boolean;successText?:string};
/** Button bound to a real async action; reports failures as a toast unless errorToast=false. */
export function ActionButton({onAction,children,className='',disabled,errorToast=true,successText,...rest}:AB){
 const [state,run]=useAction(onAction,{onError:e=>{if(errorToast)toast('bad',e.message)}});
 useEffect(()=>{if(state==='success'&&successText)toast('ok',successText)},[state,successText]);
 return <button type="button" {...rest} className={className+(state==='loading'?' is-loading':state==='success'?' is-success':state==='error'?' is-error':'')} aria-busy={state==='loading'} disabled={disabled||state==='loading'} onClick={()=>void run()}>{children}</button>;
}

/* ---------- modal ---------- */
export function Modal({title,onClose,children,footer,wide=false,label}:{title:ReactNode;onClose:()=>void;children:ReactNode;footer?:ReactNode;wide?:boolean;label?:string}){
 const {t}=useI18n();const box=useRef<HTMLElement>(null);
 useEffect(()=>{const prev=document.activeElement as HTMLElement|null;const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.stopPropagation();onClose()}};document.addEventListener('keydown',key);const first=box.current?.querySelector<HTMLElement>('input,select,textarea,button:not([data-close])');(first||box.current)?.focus({preventScroll:true});const o=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.removeEventListener('keydown',key);document.body.style.overflow=o;prev?.focus?.({preventScroll:true})}},[onClose]);
 return <div className="modalback" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><section ref={box} tabIndex={-1} className={'modal stack'+(wide?' wide':'')} role="dialog" aria-modal="true" aria-label={label||(typeof title==='string'?title:undefined)} data-localized="true">
  <div className="modal-head"><h2 className="h-spark">{title}</h2><button type="button" data-close className="icon ghost" aria-label={t('common.close')} onClick={onClose}><X size={20}/></button></div>
  {children}
  {footer&&<div className="modal-foot">{footer}</div>}
 </section></div>;
}

/* ---------- GPU status ---------- */
export function gpuTone(state:DirectStatus):'ok'|'warn'|'bad'|'idle'{return state==='READY'?'ok':state==='BUSY'||state==='LOADING'||state==='CONNECTING'?'warn':state==='ERROR'?'bad':'idle'}
export function useGpuLabel(){const {t}=useI18n();const state=useDirect(x=>x.state);const label=({READY:t('gpu.ready'),BUSY:t('gpu.busy'),LOADING:t('gpu.loading'),CONNECTING:t('gpu.connecting'),ERROR:t('gpu.error'),OFFLINE:t('gpu.offline')} as Record<DirectStatus,string>)[state];return {state,label,tone:gpuTone(state)}}
export function GpuStatus({label}:{label?:string}){const g=useGpuLabel();return <span className="status" data-tone={g.tone} role="status"><span className="dot"/>{label||g.label}</span>}

/* ---------- page head ---------- */
export function PageHead({icon,title,detail,right}:{icon?:ReactNode;title:ReactNode;detail?:ReactNode;right?:ReactNode}){
 return <header className="page-head" data-localized="true"><h1>{icon}{title}</h1>{right??<GpuStatus/>}{detail&&<p className="muted tiny">{detail}</p>}</header>;
}
export function SectionTitle({icon,children,right}:{icon?:ReactNode;children:ReactNode;right?:ReactNode}){return <div className="row" style={{justifyContent:'space-between'}}><h2 className="px-section-title">{icon}{children}</h2>{right}</div>}

/* ---------- meter ---------- */
export function Meter({value,tone,label}:{value:number;tone?:'ok';label?:string}){const p=Math.max(0,Math.min(100,value));return <div className={'px-meter'+(tone?' '+tone:'')} role="progressbar" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100} aria-label={label}><i style={{'--p':p+'%'} as CSSProperties}/></div>}

/* ---------- mascot ---------- */
export function Mascot({size=96,variant='pixel',alt=''}:{size?:number;variant?:'pixel'|'avatar';alt?:string}){return <img src={variant==='pixel'?'/brand/yoisaki-pixel.webp':size>120?'/brand/yoisaki-avatar-320.webp':'/brand/yoisaki-avatar-96.webp'} width={size} height={variant==='pixel'?Math.round(size*1.27):size} alt={alt} draggable={false} style={{width:size,height:'auto'}} loading="lazy"/>}
export function EmptyState({title,children,action}:{title:ReactNode;children?:ReactNode;action?:ReactNode}){return <div className="empty"><Mascot size={88}/><h3>{title}</h3>{children&&<p className="tiny">{children}</p>}{action}</div>}

/** Copies text and reports the real outcome. */
export async function copyText(text:string,ok:string,fail:string){try{if(!navigator.clipboard)throw Error();await navigator.clipboard.writeText(text);toast('ok',ok)}catch{toast('bad',fail)}}
