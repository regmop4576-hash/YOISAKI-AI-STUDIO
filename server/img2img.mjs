import {fail} from './errors.mjs';
import {createHash} from 'node:crypto';
// v1.7.0 Img2Img: the website sends the source already fitted to width x height; Diffusers `strength` = Denoise.
export const MODES=['text2img','img2img'];
// Exactly Diffusers get_timesteps(): Img2Img runs int(steps*strength) of the requested steps.
export const denoiseSteps=(steps,strength)=>Math.min(Math.floor(steps*strength),steps);
export function validateSourceImage(image){
 if(typeof image!=='string'||image.length>8*1024*1024||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image))fail('INVALID_SOURCE_IMAGE','Img2Img: исходное изображение должно быть PNG, JPEG или WebP до 6 МБ.');
}
export function validateImg2Img(x){
 if(x.mode!=='img2img'){
  if(x.init_image!==undefined||x.denoising_strength!==undefined)fail('INVALID_PARAMETERS','Исходное изображение и Denoise допустимы только в режиме Img2Img.');
  return {};
 }
 validateSourceImage(x.init_image);
 if(typeof x.denoising_strength!=='number'||!Number.isFinite(x.denoising_strength)||x.denoising_strength<=0||x.denoising_strength>1)fail('INVALID_PARAMETERS','Img2Img: Denoise должен быть больше 0 и не больше 1.');
 if(denoiseSteps(x.steps,x.denoising_strength)<1)fail('INVALID_PARAMETERS','Img2Img: при таком Denoise не выполняется ни одного шага. Увеличьте Denoise или Steps.');
 return {init_image:x.init_image,denoising_strength:x.denoising_strength};
}
// AUD-002 policy for the source: history/gallery keep a digest and the Denoise value, never the base64 image.
export function compactSourceRequest(request){
 if(typeof request?.init_image!=='string')return request;
 const {init_image,mask_image,...rest}=request;
 return {...rest,...(typeof mask_image==='string'?{mask_image_sha256:createHash('sha256').update(mask_image).digest('hex'),mask_image_length:mask_image.length}:{}),init_image_sha256:createHash('sha256').update(init_image).digest('hex'),init_image_length:init_image.length};
}
