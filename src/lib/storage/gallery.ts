export interface GalleryItem{id:string;name:string;created:number;favorite:boolean;prompt:string;origin:'imported';type:string;blob:Blob}
const DB='yoisaki-gallery-v1',STORE='images';
function openDB():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{const req=indexedDB.open(DB,1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(STORE))req.result.createObjectStore(STORE,{keyPath:'id'})};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
async function transaction<T>(mode:IDBTransactionMode,action:(s:IDBObjectStore)=>IDBRequest<T>):Promise<T>{const db=await openDB();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,mode);const req=action(tx.objectStore(STORE));req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);tx.oncomplete=()=>db.close();tx.onerror=()=>reject(tx.error)})}
export async function getImages(){return transaction<GalleryItem[]>('readonly',s=>s.getAll())}
export async function addImage(image:GalleryItem){await transaction('readwrite',s=>s.put(image))}
export async function deleteImage(id:string){await transaction('readwrite',s=>s.delete(id))}
export async function clearImages(){await transaction('readwrite',s=>s.clear())}
export function downloadBlob(blob:Blob,name:string){const u=URL.createObjectURL(blob);const a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}
export async function validateImage(file:File){if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('Upload PNG, JPG or WEBP.');if(file.size>25*1024*1024)throw Error('Image exceeds 25 MB.');const img=await createImageBitmap(file);if(img.width>8192||img.height>8192){img.close();throw Error('Image is too large (maximum 8192px per dimension).')}img.close()}
