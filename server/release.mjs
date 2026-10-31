import release from '../package.json' with {type:'json'};
export const WEBSITE_VERSION=release.version;
export const STUDIO_EDITION='SMART FACE FIX';
export const COMPATIBLE_ENGINE_FAMILY='1.7.0 / 1.7.6 / 1.8.0 / 1.8.1 (API 1.7.0)';
export function engineCompatibility(info){
 if(!info)return 'NOT_CONNECTED';
 return info.engine==='YOISAKI_ENGINE'&&['1.7.0','1.7.6','1.8.0','1.8.1'].includes(info.engine_version)&&(info.api_version==='1.7.0'||info.engine_version==='1.7.0'&&info.api_version===undefined)&&info.capabilities?.controlnet===true&&info.capabilities?.sdpose===true&&info.capabilities?.img2img===true?'COMPATIBLE':'UNVERIFIED';
}
// v1.8.1: automatic Face Fix is offered only when the engine declares it (older engines keep manual Face Fix).
export function supportsAutoFaceFix(info){return engineCompatibility(info)==='COMPATIBLE'&&info.capabilities?.facefix===true&&info.capabilities?.auto_facefix===true&&info.capabilities?.face_detect_contract===1}
