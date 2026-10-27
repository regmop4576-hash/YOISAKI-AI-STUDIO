import release from '../package.json' with {type:'json'};
export const WEBSITE_VERSION=release.version;
export const STUDIO_EDITION='GOOGLE DRIVE AUTO SYNC EDITION';
export const COMPATIBLE_ENGINE_FAMILY='1.7.0';
export function engineCompatibility(info){
 if(!info)return 'NOT_CONNECTED';
 return info.engine==='YOISAKI_ENGINE'&&info.engine_version==='1.7.0'&&(info.api_version===undefined||info.api_version==='1.7.0')&&info.capabilities?.controlnet===true&&info.capabilities?.sdpose===true&&info.capabilities?.img2img===true?'COMPATIBLE':'UNVERIFIED';
}
