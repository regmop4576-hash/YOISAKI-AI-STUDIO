import {fail} from './errors.mjs';
import {createHash} from 'node:crypto';
const modes=['OpenPose','Canny','Depth'];
// v1.6.2: pose preprocessors produce the same OpenPose map for the same OpenPose ControlNet.
const posePreprocessors=['openpose','sdpose'];
function validPreprocessor(type,value){return value===undefined||type==='OpenPose'&&posePreprocessors.includes(value)}
// AUD-002: history/gallery keep every ControlNet setting plus a digest, never the base64 map itself.
export function compactControlRequest(request){
 const c=request?.controlnet_config;
 if(!c||typeof c.image!=='string')return request;
 const {image,...settings}=c;
 return {...request,controlnet_config:{...settings,image_sha256:createHash('sha256').update(image).digest('hex'),image_length:image.length}};
}
export function validateControlImage(image){
 if(typeof image!=='string'||image.length>8*1024*1024||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image))fail('INVALID_CONTROL_IMAGE','Нужен PNG, JPEG или WebP до 6 МБ.');
}
export function validateControl(c,regions=[]){
 if(!c||typeof c.enabled!=='boolean')fail('INVALID_CONTROL','Неверная конфигурация ControlNet.');
 if(!c.enabled)return;
 if(regions.some(r=>r.enabled))fail('CONTROL_REGIONAL_CONFLICT','Одновременная работа Regional Control и ControlNet пока не поддерживается.');
 if(!modes.includes(c.type)||c.map_type!==c.type)fail('INVALID_CONTROL','Тип карты изменился. Подготовьте карту заново.');
 if(!validPreprocessor(c.type,c.preprocessor))fail('INVALID_CONTROL','Неверный препроцессор позы.');
 if(!Number.isFinite(c.strength)||c.strength<0||c.strength>2||!Number.isFinite(c.start)||!Number.isFinite(c.end)||c.start<0||c.start>=c.end||c.end>1)fail('INVALID_CONTROL','ControlNet: требуется Strength 0–2 и 0 ≤ Start < End ≤ 1.');
 validateControlImage(c.image);
}
export function validatePreprocess(x){
 if(!x||!modes.includes(x.type)||typeof x.prepared!=='boolean'||![x.width,x.height].every(v=>Number.isInteger(v)&&v>=256&&v<=1536&&v%8===0)||!validPreprocessor(x.type,x.preprocessor))fail('INVALID_CONTROL','Неверные параметры предобработки.');
 validateControlImage(x.image);
 return {type:x.type,prepared:x.prepared,width:x.width,height:x.height,image:x.image,...(x.type==='OpenPose'?{preprocessor:x.preprocessor??'openpose'}:{})};
}
