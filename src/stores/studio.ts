'use client';
import type {Regional} from '@/lib/regional';
import {localApi} from '@/lib/local-api';
import {FACE_DEFAULTS,DEFAULT_STRENGTH,type FaceProfile} from '@/lib/facefix';
import {create} from 'zustand';import {persist,createJSONStorage} from 'zustand/middleware';
export type LoRA={id:string;name:string;trigger:string;weight:number;enabled:boolean};
export type Parameters={regional:Regional;prompt:string;negative:string;checkpoint:string;vae:string;loras:LoRA[];width:number;height:number;steps:number;cfg:number;sampler:string;scheduler:string;seed:string;randomSeed:boolean;batch:number;denoise:number;controlEnabled:boolean;controlType:string;controlPreprocessor:string;controlStrength:number;controlStart:number;controlEnd:number;mode:'text2img'|'img2img'};
export const defaults:Parameters={regional:{mode:'OFF',regions:[]},prompt:'',negative:'',checkpoint:'',vae:'auto',loras:[],width:1024,height:1024,steps:30,cfg:5,sampler:'Euler',scheduler:'Normal',seed:'',randomSeed:true,batch:1,denoise:.5,controlEnabled:false,controlType:'OpenPose',controlPreprocessor:'openpose',controlStrength:.8,controlStart:0,controlEnd:1,mode:'text2img'};
export type Preset={id:string;name:string;version:1;settings:Parameters};
/** v1.9.0 PIXEL FANTASY: interface preferences. Every switch here changes real behaviour (see Shell / Settings). */
export type UiPrefs={motion:'system'|'off';decor:'full'|'compact';pixelText:boolean;largeText:boolean;showCloudCompute:boolean};
export const uiDefaults:UiPrefs={motion:'system',decor:'full',pixelText:false,largeText:false,showCloudCompute:false};
export type EditorMode='IMG2IMG'|'INPAINT'|'FACE FIX';
/** v1.9.0: editor working parameters live here (persisted with the settings), so Editor → Gallery → Editor keeps them. */
export type EditorPrefs={mode:EditorMode;classic:boolean;
 inpaint:{brush:number;erase:boolean;denoise:number;padding:number;blur:number;regionMode:'crop'|'full'};
 faceRegion:{padding:number;denoise:number;blur:number;width:number;height:number};
 faceFix:{strength:number;profile:Omit<FaceProfile,'sampler'|'scheduler'>&{sampler?:string;scheduler?:string};showUncertain:boolean}};
export const editorDefaults:EditorPrefs={mode:'INPAINT',classic:false,
 inpaint:{brush:35,erase:false,denoise:.5,padding:.15,blur:8,regionMode:'crop'},
 faceRegion:{padding:.15,denoise:.25,blur:8,width:512,height:512},
 faceFix:{strength:DEFAULT_STRENGTH,profile:{...FACE_DEFAULTS},showUncertain:false}};
interface Studio{settings:Parameters;presets:Preset[];language:string;ui:UiPrefs;editor:EditorPrefs;update:(partial:Partial<Parameters>)=>void;save:(name:string)=>void;load:(id:string)=>void;remove:(id:string)=>void;rename:(id:string,name:string)=>void;duplicate:(id:string)=>void;addPreset:(p:Preset)=>void;reset:()=>void;setLanguage:(v:string)=>void;
 setUi:(p:Partial<UiPrefs>)=>void;setEditor:(p:Partial<EditorPrefs>)=>void;setInpaint:(p:Partial<EditorPrefs['inpaint']>)=>void;setFaceRegion:(p:Partial<EditorPrefs['faceRegion']>)=>void;setFaceFix:(p:Partial<Omit<EditorPrefs['faceFix'],'profile'>>&{profile?:Partial<EditorPrefs['faceFix']['profile']>})=>void;resetEditor:()=>void}
const num=(v:unknown,d:number)=>typeof v==='number'&&Number.isFinite(v)?v:d;
function mergeEditor(saved:unknown):EditorPrefs{
 const s=(saved&&typeof saved==='object'?saved:{}) as Partial<EditorPrefs>;const d=editorDefaults;
 const mode=(['IMG2IMG','INPAINT','FACE FIX'] as const).includes(s.mode as EditorMode)?s.mode as EditorMode:d.mode;
 const ip={...d.inpaint,...(s.inpaint||{})},fr={...d.faceRegion,...(s.faceRegion||{})},ff=s.faceFix||d.faceFix;
 return {mode,classic:s.classic===true,
  inpaint:{brush:num(ip.brush,35),erase:ip.erase===true,denoise:num(ip.denoise,.5),padding:num(ip.padding,.15),blur:num(ip.blur,8),regionMode:ip.regionMode==='full'?'full':'crop'},
  faceRegion:{padding:num(fr.padding,.15),denoise:num(fr.denoise,.25),blur:num(fr.blur,8),width:num(fr.width,512),height:num(fr.height,512)},
  faceFix:{strength:num(ff.strength,DEFAULT_STRENGTH),profile:{...FACE_DEFAULTS,...(ff.profile||{})},showUncertain:ff.showUncertain===true}};
}
function mergeUi(saved:unknown):UiPrefs{const s=(saved&&typeof saved==='object'?saved:{}) as Partial<UiPrefs>;return {motion:s.motion==='off'?'off':'system',decor:s.decor==='compact'?'compact':'full',pixelText:s.pixelText===true,largeText:s.largeText===true,showCloudCompute:s.showCloudCompute===true}}
export const useStudio=create<Studio>()(persist((set,get)=>({settings:defaults,presets:[],language:'Русский',ui:uiDefaults,editor:editorDefaults,
 update:partial=>set(s=>({settings:{...s.settings,...partial}})),
 save:name=>set(s=>({presets:[...s.presets,{id:crypto.randomUUID(),name,version:1,settings:structuredClone(s.settings)}]})),
 load:id=>{const p=get().presets.find(x=>x.id===id);if(p)set({settings:{...structuredClone(p.settings),checkpoint:'',loras:[],vae:'auto'}})},
 remove:id=>set(s=>({presets:s.presets.filter(p=>p.id!==id)})),
 rename:(id,name)=>set(s=>({presets:s.presets.map(p=>p.id===id?{...p,name}:p)})),
 duplicate:id=>{const p=get().presets.find(x=>x.id===id);if(p)set(s=>({presets:[...s.presets,{...structuredClone(p),id:crypto.randomUUID(),name:p.name+' copy'}]}))},
 addPreset:p=>set(s=>({presets:[...s.presets,{...p,id:crypto.randomUUID()}]})),
 reset:()=>set({settings:defaults}),setLanguage:language=>set({language}),
 setUi:p=>set(s=>({ui:{...s.ui,...p}})),
 setEditor:p=>set(s=>({editor:{...s.editor,...p}})),
 setInpaint:p=>set(s=>({editor:{...s.editor,inpaint:{...s.editor.inpaint,...p}}})),
 setFaceRegion:p=>set(s=>({editor:{...s.editor,faceRegion:{...s.editor.faceRegion,...p}}})),
 setFaceFix:({profile,...p})=>set(s=>({editor:{...s.editor,faceFix:{...s.editor.faceFix,...p,profile:{...s.editor.faceFix.profile,...(profile||{})}}}})),
 resetEditor:()=>set({editor:editorDefaults})}),
 {name:'yoisaki-studio-v1',version:2,migrate:(saved:any,version)=>version<2?{...saved,language:'Русский'}:saved,skipHydration:true,
  storage:createJSONStorage(()=>({getItem:async()=>{const x=await localApi<{value:unknown}>('/api/settings');return x.value?JSON.stringify(x.value):null},setItem:async(_name:string,value:string)=>{await localApi('/api/settings',{method:'PUT',body:JSON.stringify({value:JSON.parse(value)})})},removeItem:async()=>{}})),
  partialize:s=>({settings:s.settings,presets:s.presets,language:s.language,ui:s.ui,editor:s.editor}),
  merge:(persisted,current)=>{try{const p=persisted as Partial<Studio>;return {...current,settings:{...defaults,...(p.settings||{}),},presets:Array.isArray(p.presets)?p.presets.filter(x=>x?.version===1&&typeof x.name==='string'&&x.settings):[],language:typeof p.language==='string'?p.language:'Русский',ui:mergeUi(p.ui),editor:mergeEditor(p.editor)}}catch{return current}}}));
