'use client';
// v1.9.0 · Key-based localisation. Russian is the default and the source of keys; every other language is a typed
// dictionary with the same keys (TypeScript reports a missing translation). Adding a language = adding one file and
// one entry in LANGS — components never change. Legacy components keep their inline ru/en pairs and LocaleBridge.
import {useCallback} from 'react';
import {useStudio} from '@/stores/studio';
import {ru} from './ru';
import {en} from './en';
export type MessageKey=keyof typeof ru;
export type Dict=Record<MessageKey,string>;
export const LANGS={ru:{label:'Русский',dict:ru as Dict},en:{label:'English',dict:en}} as const;
export type Lang=keyof typeof LANGS;
/** Stored setting value ('Русский' | 'English') → language code. Unknown values fall back to Russian. */
export function langOf(language:string):Lang{return (Object.entries(LANGS).find(([,v])=>v.label===language)?.[0] as Lang)||'ru'}
type Vars=Record<string,string|number>;
export function format(text:string,vars?:Vars){return vars?text.replace(/\{(\w+)\}/g,(m,k)=>k in vars?String(vars[k]):m):text}
export function translateKey(lang:Lang,key:MessageKey,vars?:Vars){return format(LANGS[lang].dict[key]??ru[key]??key,vars)}
/** Non-hook access (event handlers, stores). */
export function tr(key:MessageKey,vars?:Vars){return translateKey(langOf(useStudio.getState().language),key,vars)}
export function useI18n(){
 const lang=langOf(useStudio(s=>s.language));
 const t=useCallback((key:MessageKey,vars?:Vars)=>translateKey(lang,key,vars),[lang]);
 /** Translates an enum value (stage / status codes) via `${prefix}.${value}`; unknown values are shown as is. */
 const tv=useCallback((prefix:string,value:string)=>{const k=`${prefix}.${value}`;return k in ru?translateKey(lang,k as MessageKey):value},[lang]);
 return {t,tv,lang,locale:lang==='en'?'en-US':'ru-RU'};
}
