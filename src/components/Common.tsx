'use client';
// Shared form pieces (v1.9.0 PIXEL FANTASY). Same exports and props as before so every page keeps working.
import {useState,useRef,useEffect,type CSSProperties,type ReactNode,type InputHTMLAttributes} from 'react';
import {Copy,Trash2,Upload,ChevronDown,ChevronUp,Pencil} from './icons';
import {downloadBlob,validateImage} from '@/lib/storage/gallery';
import {useI18n} from '@/i18n';
import {PageHead,GpuStatus,copyText,toast} from './ui';
export function Head({title,detail,statusLabel}:{title:string;detail:string;statusLabel?:string}){return <PageHead title={title} detail={detail} right={<GpuStatus label={statusLabel?'GPU · '+statusLabel:undefined}/>}/>}
export function Tabs({options,value,onChange,labels,fit}:{options:string[];value:string;onChange:(v:string)=>void;labels?:Record<string,ReactNode>;fit?:boolean}){return <div className={'px-tabs'+(fit?' fit':'')} role="tablist">{options.map(o=><button type="button" role="tab" aria-selected={o===value} className={'pill '+(o===value?'selected':'')} key={o} onClick={()=>onChange(o)}>{labels?.[o]??o}</button>)}</div>}
/** Prompt editor. `label` stays the stable English identifier used by aria/tests; the visible caption is localised. */
export function Prompt({label,value,onChange,caption,placeholder,max=4000}:{label:string;value:string;onChange:(s:string)=>void;caption?:ReactNode;placeholder?:string;max?:number}){
 const {t}=useI18n();const [expanded,setExpanded]=useState(false);const negative=/negative/i.test(label);
 const shown=caption??(negative?t('prompt.negative'):t('prompt.positive'));
 return <div className="prompt-box" data-localized="true"><div className="prompt-head"><span className="label"><Pencil size={16}/>{shown}{negative&&<span className="muted tiny">({t('prompt.optional')})</span>}</span><span className="tools">
  <button type="button" className="icon" aria-label={t('prompt.copy')} title={t('prompt.copy')} disabled={!value} onClick={()=>void copyText(value,t('toast.copied'),t('toast.copyFailed'))}><Copy size={16}/></button>
  <button type="button" className="icon" aria-label={t('prompt.clear')} title={t('prompt.clear')} disabled={!value} onClick={()=>{onChange('');toast('info',t('toast.promptCleared'))}}><Trash2 size={16}/></button>
  <button type="button" className="icon" aria-label={expanded?t('prompt.collapse'):t('prompt.expand')} aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?<ChevronUp size={16}/>:<ChevronDown size={16}/>}</button></span></div>
  <div className="prompt-wrap"><textarea aria-label={typeof shown==='string'?shown:label} data-prompt={negative?'negative':'positive'} value={value} rows={expanded?10:negative?3:4} onChange={e=>onChange(e.target.value)} placeholder={placeholder??(negative?t('prompt.negativePh'):t('prompt.positivePh'))} spellCheck={false}/><span className="prompt-count">{value.length}/{max}</span></div></div>;
}
export function Slider({label,min,max,step,value,onChange,caption,disabled}:{label:string;min:number;max:number;step:number;value:number;onChange:(x:number)=>void;caption?:ReactNode;disabled?:boolean}){
 const p=((value-min)/(max-min))*100;
 return <div className="field slider-field"><div className="row"><label>{caption??label}</label><b>{Number.isInteger(step)?value:Number(value.toFixed(2))}</b></div><input aria-label={label} type="range" min={min} max={max} step={step} value={value} disabled={disabled} style={{'--p':Math.max(0,Math.min(100,p))+'%'} as CSSProperties} onChange={e=>onChange(Number(e.target.value))}/></div>;
}
export function ImageUpload({onFile,label,className=''}:{onFile:(f:File)=>void;label?:string;className?:string}){
 const {t}=useI18n();const [error,setError]=useState('');const input=useRef<HTMLInputElement>(null);
 return <><input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={async e=>{const f=e.target.files?.[0];if(!f)return;try{await validateImage(f);setError('');onFile(f)}catch(err){setError((err as Error).message)}e.target.value=''}}/><button type="button" className={className} onClick={()=>input.current?.click()}><Upload size={18}/>{label??t('common.uploadImage')}</button>{error&&<div className="notice dangernotice tiny" role="alert">{error}</div>}</>;
}
export function downloadJSON(data:unknown,name:string){downloadBlob(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),name)}
/** v1.9.2 · Numeric field that is safe to edit with the Android on-screen keyboard.
 * While focused it keeps the raw text, so the user can erase it completely, paste, or type "24," / "-" step by step;
 * the parent receives a number only when the text is a valid number. On blur the field shows the committed value
 * again. `type="text"` + `inputMode` gives the numeric keyboard without the type="number" sanitising quirks. */
export function NumberField({value,onCommit,onEmpty,decimal=false,negative=false,...rest}:{value:number|null|undefined;onCommit:(n:number)=>void;onEmpty?:()=>void;decimal?:boolean;negative?:boolean}&Omit<InputHTMLAttributes<HTMLInputElement>,'value'|'onChange'|'type'|'defaultValue'>){
 const shown=value==null||!Number.isFinite(value)?'':String(value);
 const [text,setText]=useState(shown);const focused=useRef(false);
 useEffect(()=>{if(!focused.current)setText(shown)},[shown]);
 const ok=decimal?(negative?/^-?\d*[.,]?\d*$/:/^\d*[.,]?\d*$/):(negative?/^-?\d*$/:/^\d*$/);
 return <input {...rest} type="text" inputMode={decimal?'decimal':'numeric'} autoComplete="off" autoCorrect="off" spellCheck={false} enterKeyHint="done" value={text}
  onFocus={e=>{focused.current=true;rest.onFocus?.(e)}}
  onChange={e=>{const raw=e.target.value.replace(/\s/g,'');if(!ok.test(raw))return;setText(raw);if(raw===''){onEmpty?.();return}const n=Number(raw.replace(',','.'));if(raw!=='-'&&!raw.endsWith('.')&&!raw.endsWith(',')&&Number.isFinite(n))onCommit(n)}}
  onBlur={e=>{focused.current=false;setText(shown);rest.onBlur?.(e)}}/>;
}
