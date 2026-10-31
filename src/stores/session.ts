'use client';
// v1.9.0 · In-memory working state that must survive page switches (Editor → Gallery → Editor) but is too heavy or
// too short-lived for the persisted settings: loaded images, mask strokes, face boxes, detections and running jobs.
// Images are also written to IndexedDB drafts (lib/storage/drafts) so they come back after a page reload.
import {create} from 'zustand';
import type {Box,Stroke} from '@/lib/editor';
import type {Detection} from '@/lib/facefix';
import type {LiveJob} from '@/components/Generator';
import type {ControlMap} from '@/lib/controlnet';
export type LoadedImage={imageId:string;name:string;image:HTMLImageElement;file:Blob};
export type CanvasSlot={img:LoadedImage|null;strokes:Stroke[];redo:Stroke[];box:Box|null;job:LiveJob|null;restored:boolean};
export type FaceFixSlot={img:LoadedImage|null;detection:Detection|null;selected:string[];manual:boolean;box:Box|null;job:LiveJob|null;result:string;restored:boolean};
export type SourceSlot={file:File|null;imageId:string;restored:boolean};
type Session={
 inpaint:CanvasSlot;facebox:CanvasSlot;facefix:FaceFixSlot;
 img2img:SourceSlot;control:SourceSlot;controlMap:ControlMap|null;controlRevision:number;controlPrepared:boolean;setControl:(p:{controlRevision?:number;controlPrepared?:boolean})=>void;
 jobs:{generate:LiveJob|null;img2img:LiveJob|null};
 setCanvas:(slot:'inpaint'|'facebox',p:Partial<CanvasSlot>|((s:CanvasSlot)=>Partial<CanvasSlot>))=>void;
 setFaceFix:(p:Partial<FaceFixSlot>|((s:FaceFixSlot)=>Partial<FaceFixSlot>))=>void;
 setSource:(slot:'img2img'|'control',p:Partial<SourceSlot>)=>void;
 setControlMap:(m:ControlMap|null)=>void;
 setJob:(key:'generate'|'img2img',job:LiveJob|null)=>void;
 clearAll:()=>void;
};
const emptyCanvas=():CanvasSlot=>({img:null,strokes:[],redo:[],box:null,job:null,restored:false});
const emptyFace=():FaceFixSlot=>({img:null,detection:null,selected:[],manual:false,box:null,job:null,result:'',restored:false});
const emptySource=():SourceSlot=>({file:null,imageId:'',restored:false});
export const useSession=create<Session>((set)=>({
 inpaint:emptyCanvas(),facebox:emptyCanvas(),facefix:emptyFace(),img2img:emptySource(),control:emptySource(),controlMap:null,controlRevision:0,controlPrepared:false,setControl:p=>set(p),jobs:{generate:null,img2img:null},
 setCanvas:(slot,p)=>set(s=>({[slot]:{...s[slot],...(typeof p==='function'?p(s[slot]):p)}}) as Partial<Session>),
 setFaceFix:p=>set(s=>({facefix:{...s.facefix,...(typeof p==='function'?p(s.facefix):p)}})),
 setSource:(slot,p)=>set(s=>({[slot]:{...s[slot],...p}}) as Partial<Session>),
 setControlMap:controlMap=>set({controlMap}),
 setJob:(key,job)=>set(s=>({jobs:{...s.jobs,[key]:job}})),
 clearAll:()=>set({inpaint:{...emptyCanvas(),restored:true},facebox:{...emptyCanvas(),restored:true},facefix:{...emptyFace(),restored:true},img2img:{...emptySource(),restored:true},control:{...emptySource(),restored:true},controlMap:null}),
}));
