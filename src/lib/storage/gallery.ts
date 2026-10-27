import {localApi,localFetch} from '../local-api';
export interface GalleryItem{id:string;name:string;created:number;favorite:boolean;prompt:string;origin:'imported'|'generated';type:string;blob?:Blob;url?:string;seed?:number;parameters?:Record<string,unknown>}
export async function getImages(){return (await localApi<{items:GalleryItem[]}>('/api/gallery')).items}
export async function addImage(image:GalleryItem){if(image.blob)await localFetch('/api/gallery/'+encodeURIComponent(image.id)+'?name='+encodeURIComponent(image.name),{method:'POST',headers:{'Content-Type':image.type},body:image.blob});else await localApi('/api/gallery/'+encodeURIComponent(image.id),{method:'PATCH',body:JSON.stringify({prompt:image.prompt,favorite:image.favorite})})}
export async function deleteImage(id:string){await localApi('/api/gallery/'+encodeURIComponent(id),{method:'DELETE'})}
export async function clearImages(){await localApi('/api/gallery',{method:'DELETE'})}
export function downloadBlob(blob:Blob,name:string){const u=URL.createObjectURL(blob);const a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}
export function downloadImage(item:GalleryItem){const a=document.createElement('a');a.href=item.url||'';a.download=item.name;a.click()}
export async function validateImage(file:File){if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('Upload PNG, JPG or WEBP.');if(file.size>25*1024*1024)throw Error('Image exceeds 25 MB.');const img=await createImageBitmap(file);if(img.width>8192||img.height>8192){img.close();throw Error('Image is too large (maximum 8192px per dimension).')}img.close()}
