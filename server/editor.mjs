import {fail} from './errors.mjs';
import {validateSourceImage,denoiseSteps} from './img2img.mjs';
export const EDIT_MODES=['inpaint','facefix'];
export function validateEditor(x){
 if(!EDIT_MODES.includes(x.mode)){
  if(['mask_image','face_region','mask_blur','mask_padding','inpaint_region','face_detection','face_options'].some(k=>x[k]!=null))fail('INVALID_PARAMETERS','Поля редактора допустимы только в Inpaint/Face Fix.');
  return {};
 }
 validateSourceImage(x.init_image);
 if(x.batch_size!==1||x.controlnet_config?.enabled||x.regions?.some(r=>r.enabled))fail('EDITOR_INCOMPATIBLE','Редактор: batch 1; отключите ControlNet и Regional Control.');
 if(!Number.isFinite(x.denoising_strength)||x.denoising_strength<=0||x.denoising_strength>1||denoiseSteps(x.steps,x.denoising_strength)<1)fail('INVALID_PARAMETERS','Denoise должен давать хотя бы один шаг и быть в диапазоне (0, 1].');
 const out={init_image:x.init_image,denoising_strength:x.denoising_strength,mask_blur:x.mask_blur??8,mask_padding:x.mask_padding??.15,inpaint_region:x.inpaint_region??'crop'};
 if(!Number.isFinite(out.mask_blur)||out.mask_blur<0||out.mask_blur>64||!Number.isFinite(out.mask_padding)||out.mask_padding<0||out.mask_padding>1||!['crop','full'].includes(out.inpaint_region))fail('INVALID_PARAMETERS','Неверные параметры маски.');
 if(x.mode==='inpaint'){
  validateSourceImage(x.mask_image);
  if(!x.mask_image.startsWith('data:image/png;base64,')||x.face_region!=null||x.face_detection!=null||x.face_options!=null)fail('INVALID_PARAMETERS','Inpaint: нужна маска PNG.');
  out.mask_image=x.mask_image;
 }else{
  const r=x.face_region;
  if(x.mask_image!=null||out.inpaint_region!=='crop'||(r==null)===(x.face_detection==null))fail('INVALID_PARAMETERS','Face Fix: нужна либо ручная рамка, либо выбранные найденные лица.');
  if(r!=null){
   if(Object.keys(r).sort().join(',')!=='height,width,x,y'||!Object.values(r).every(Number.isFinite)||r.x<0||r.y<0||r.width<2||r.height<2||r.x+r.width>8192||r.y+r.height>8192)fail('INVALID_PARAMETERS','Неверное выделение лица.');
   out.face_region={...r};
  }else out.face_detection=validateFaceDetection(x.face_detection);
  if(x.face_options!=null)out.face_options=validateFaceOptions(x.face_options);
 }
 // Actual decoding, EXIF, dimensions and exact bounds are checked by the authenticated GPU API.
 return out;
}

// v1.8.1 SMART FACE FIX. Ids are opaque; the GPU re-detects faces on the exact source and rejects unknown ids.
export const FACE_DETECTORS=['auto','anime','human'];
function detectorOptions(x){
 const detector=x.detector??'auto',min=x.min_confidence??.35;
 if(!FACE_DETECTORS.includes(detector)||typeof min!=='number'||!Number.isFinite(min)||min<.05||min>.95)fail('INVALID_PARAMETERS','Детектор: auto, anime или human; порог 0.05–0.95.');
 return {detector,min_confidence:min};
}
export function validateFaceDetection(x){
 if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).sort().join(',')!=='detector,min_confidence,select')fail('INVALID_PARAMETERS','face_detection: нужны detector, min_confidence, select.');
 const ids=x.select;
 if(!Array.isArray(ids)||ids.length<1||ids.length>12||new Set(ids).size!==ids.length||!ids.every(i=>typeof i==='string'&&/^f[a-f0-9]{12}$/.test(i)))fail('INVALID_PARAMETERS','Выберите от 1 до 12 найденных лиц.');
 return {...detectorOptions(x),select:[...ids]};
}
export function validateFaceOptions(x){
 if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).sort().join(',')!=='mask_expand,mask_shape,work_fit'||!['ellipse','box'].includes(x.mask_shape)||!['aspect','letterbox'].includes(x.work_fit)||typeof x.mask_expand!=='number'||!Number.isFinite(x.mask_expand)||x.mask_expand<0||x.mask_expand>.5)fail('INVALID_PARAMETERS','face_options: ellipse|box, расширение 0–0.5, aspect|letterbox.');
 return {mask_shape:x.mask_shape,mask_expand:x.mask_expand,work_fit:x.work_fit};
}
export function validateDetectRequest(x){
 if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!['image','detector','min_confidence'].includes(k)))fail('INVALID_PARAMETERS','Ожидаются image, detector, min_confidence.');
 validateSourceImage(x.image);
 return {image:x.image,...detectorOptions(x)};
}
// The browser receives only validated integer boxes inside the reported image.
export function validateDetectResponse(r,request){
 const ok=r&&Array.isArray(r.faces)&&r.faces.length<=12&&r.detector===request.detector&&Number.isInteger(r.image?.width)&&Number.isInteger(r.image?.height)&&r.faces.every(f=>f&&/^f[a-f0-9]{12}$/.test(f.id)&&['x','y','width','height'].every(k=>Number.isInteger(f[k])&&f[k]>=0)&&f.width>=8&&f.height>=8&&f.x+f.width<=r.image.width&&f.y+f.height<=r.image.height&&Number.isFinite(f.confidence)&&f.confidence>=0&&f.confidence<=1&&typeof f.detector==='string'&&typeof f.auto_selectable==='boolean')&&(r.selected===null||r.faces.some(f=>f.id===r.selected));
 if(!ok)fail('INVALID_RESPONSE','Неверный ответ детектора лиц от GPU.',502);
 return {detector:r.detector,detectors_run:Array.isArray(r.detectors_run)?r.detectors_run.filter(x=>typeof x==='string'):[],min_confidence:r.min_confidence,auto_select_confidence:r.auto_select_confidence,image:{width:r.image.width,height:r.image.height},
  faces:r.faces.map(f=>({id:f.id,x:f.x,y:f.y,width:f.width,height:f.height,confidence:f.confidence,detector:f.detector,label:'face',auto_selectable:f.auto_selectable})),selected:r.selected,selection_required:r.selection_required===true,duration_ms:Number.isFinite(r.duration_ms)?r.duration_ms:null};
}
