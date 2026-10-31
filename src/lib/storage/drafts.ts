// v1.9.0 · Editor drafts in the browser's IndexedDB (never localStorage: images can be megabytes).
// A draft is one source image per editor slot plus small JSON data bound to that image (mask strokes, face box,
// detection, last job). Every record carries `imageId`; data written for another image is rejected, so masks or
// face coordinates can never be applied to a different picture.
export type DraftSlot='img2img'|'control'|'inpaint'|'facebox'|'facefix';
export type Draft<T=unknown>={slot:DraftSlot;imageId:string;name:string;type:string;blob:Blob;updated:number;data?:T};
const DB='yoisaki-drafts',STORE='drafts',VERSION=1;
let opening:Promise<IDBDatabase>|null=null;
function db(){
 if(typeof indexedDB==='undefined')return Promise.reject(Error('IndexedDB недоступен'));
 return opening??=new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(DB,VERSION);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(STORE))r.result.createObjectStore(STORE,{keyPath:'slot'})};r.onsuccess=()=>resolve(r.result);r.onerror=()=>{opening=null;reject(r.error||Error('IndexedDB error'))};r.onblocked=()=>{opening=null;reject(Error('IndexedDB blocked'))}});
}
function tx<T>(mode:IDBTransactionMode,run:(s:IDBObjectStore)=>IDBRequest<T>|void):Promise<T|undefined>{
 return db().then(d=>new Promise<T|undefined>((resolve,reject)=>{const t=d.transaction(STORE,mode);const s=t.objectStore(STORE);const req=run(s);let value:T|undefined;if(req)req.onsuccess=()=>{value=req.result};t.oncomplete=()=>resolve(value);t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error||Error('aborted'))}));
}
export const newImageId=()=>crypto.randomUUID();
export async function saveDraft(slot:DraftSlot,imageId:string,file:Blob,name:string,data?:unknown){
 await tx('readwrite',s=>s.put({slot,imageId,name,type:file.type,blob:file,updated:Date.now(),data} satisfies Draft));
}
export async function loadDraft<T=unknown>(slot:DraftSlot):Promise<Draft<T>|null>{
 try{return ((await tx<Draft<T>>('readonly',s=>s.get(slot)))??null)}catch{return null}
}
/** Updates the data bound to an image; ignored if the slot now holds another image. */
export async function saveDraftData(slot:DraftSlot,imageId:string,data:unknown){
 // One read-write transaction: the check and the write cannot interleave with another image being stored.
 try{await tx('readwrite',s=>{const r=s.get(slot);r.onsuccess=()=>{const d=r.result as Draft|undefined;if(d&&d.imageId===imageId)s.put({...d,data,updated:Date.now()})}})}catch{/* drafts are best effort */}
}
export async function clearDraft(slot:DraftSlot){try{await tx('readwrite',s=>s.delete(slot))}catch{}}
export async function clearAllDrafts(){try{await tx('readwrite',s=>s.clear())}catch{}}
export async function draftSummary(){try{const all=await tx<Draft[]>('readonly',s=>s.getAll())||[];return {count:all.length,bytes:all.reduce((n,d)=>n+(d.blob?.size||0),0)}}catch{return {count:0,bytes:0}}}
/** Debounced writer for frequently changing data (mask strokes while painting). Pending data is flushed when the
 * page is hidden or unloaded, so a quick reload right after a brush stroke does not lose it. */
const pending=new Set<()=>void>();
if(typeof window!=='undefined'){const flush=()=>{for(const f of [...pending])f()};window.addEventListener('pagehide',flush);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')flush()})}
export function draftDataWriter(slot:DraftSlot,ms=250){let t:ReturnType<typeof setTimeout>|undefined;let job:(()=>void)|null=null;
 return (imageId:string,data:unknown)=>{clearTimeout(t);if(job)pending.delete(job);const run=()=>{clearTimeout(t);pending.delete(run);job=null;void saveDraftData(slot,imageId,data)};job=run;pending.add(run);t=setTimeout(run,ms)}}
