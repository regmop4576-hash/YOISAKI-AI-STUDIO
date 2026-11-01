// In-memory double of the Google Drive API v3 endpoints the app uses (about, files.list, files.get, alt=media with
// Range) and of the OAuth token endpoint. SIMULATED: no real Google account or network is involved.
import {AppError} from '../../server/errors.mjs';
export const CLIENT={client_id:'123456789-abcdefghij.apps.googleusercontent.com',client_secret:'GOCSPX-test_secret'};
export const account=(folder={id:'models-root',name:'YOISAKI_MODELS'},expiry='2099-01-01T00:00:00Z')=>({session_id:'s1',client:CLIENT,token:{access_token:'private-access',refresh_token:'private-refresh',expiry},account:{email:'user@example.invalid',name:'User'},folder});
// Structurally valid safetensors header + declared payload; returns {header: Buffer, size}.
export function safetensors(keys,meta={},payload=1024){
 const each=Math.max(1,Math.floor(payload/keys.length));const tensors=Object.fromEntries(keys.map((k,i)=>[k,{dtype:'U8',shape:[each],data_offsets:[i*each,(i+1)*each]}]));
 const json=Buffer.from(JSON.stringify({__metadata__:meta,...tensors}));const prefix=Buffer.alloc(8);prefix.writeBigUInt64LE(BigInt(json.length));
 const header=Buffer.concat([prefix,json]);return {header,size:header.length+each*keys.length};
}
export const KEYS={checkpoint:['conditioner.embedders.1.model.w','model.diffusion_model.input.w','first_stage_model.w'],lora_xl:['lora_te2_text_model.lora_up.weight','lora_unet_down.lora_down.weight'],lora_sd1:['lora_te_text_model.lora_up.weight','lora_unet_down.lora_down.weight'],vae:['decoder.conv_in.weight','encoder.conv_out.weight']};
export class FakeDrive{
 constructor(){this.nodes=new Map();this.calls=[];this.media=[];this.errors=new Map();this.offline=false;this.refresh='ok';this.ignoreRange=false;this.add({id:'models-root',name:'YOISAKI_MODELS',folder:true,parent:'root'})}
 add(n){this.nodes.set(n.id,{trashed:false,canDownload:true,modified:'2026-10-20T10:00:00.000Z',...n});return n.id}
 folder(id,name,parent='models-root'){return this.add({id,name,folder:true,parent})}
 file(id,name,parent,{size,header=null,md5=null,sha256=null,canDownload=true,mime='application/octet-stream'}={}){return this.add({id,name,parent,size:size??header?.length??0,header,md5:md5??id.padEnd(32,'0').slice(0,32).replace(/[^a-f0-9]/g,'a'),sha256,canDownload,mime})}
 meta(n){const m={id:n.id,name:n.name,mimeType:n.folder?'application/vnd.google-apps.folder':n.shortcut?'application/vnd.google-apps.shortcut':n.mime,trashed:n.trashed,modifiedTime:n.modified,capabilities:{canDownload:n.canDownload},parents:n.parent==='root'?undefined:[n.parent]};
  if(!n.folder&&!n.shortcut){m.size=String(n.size);m.md5Checksum=n.md5;if(n.sha256)m.sha256Checksum=n.sha256;m.headRevisionId='rev-'+n.id}
  if(n.shortcut)m.shortcutDetails={targetId:n.target,targetMimeType:this.nodes.get(n.target)?.folder?'application/vnd.google-apps.folder':'application/octet-stream'};
  return m}
 check(id){if(this.offline)throw new AppError('PROVIDER_NETWORK','Нет связи с провайдером: проверьте сеть.',502);const e=this.errors.get(id)||this.errors.get('*');if(e)return {status:e.status,json:{error:{code:e.status,errors:[{reason:e.reason||'forbidden'}]}}};return null}
 request=async(url,opts={})=>{
  this.calls.push(url);
  if(url.startsWith('https://oauth2.googleapis.com/token')){if(this.offline)throw new AppError('PROVIDER_NETWORK','Нет связи с провайдером.',502);return this.refresh==='ok'?{status:200,json:{access_token:'refreshed-private-access',expires_in:3600,scope:'https://www.googleapis.com/auth/drive.readonly'}}:{status:400,json:{error:'invalid_grant'}}}
  const u=new URL(url);if(u.hostname!=='www.googleapis.com')throw Error('unexpected host '+url);
  if(opts.headers?.Authorization!=='Bearer private-access'&&opts.headers?.Authorization!=='Bearer refreshed-private-access')return {status:401,json:{error:{code:401}}};
  const p=u.pathname.replace('/drive/v3','');
  if(p==='/about'){const e=this.check('about');if(e)return e;return {status:200,json:{user:{emailAddress:'user@example.invalid',displayName:'User'}}}}
  if(p==='/files'){
   const q=u.searchParams.get('q');const parent=q.match(/^'([^']+)' in parents/)[1];const e=this.check(parent);if(e)return e;
   const name=q.match(/name contains '((?:[^'\\]|\\.)*)'/)?.[1]?.replace(/\\(.)/g,'$1');
   let list=[...this.nodes.values()].filter(n=>n.parent===parent&&!n.trashed&&(!name||n.name.toLowerCase().includes(name.toLowerCase())));
   if(q.includes("mimeType = 'application/vnd.google-apps.folder'"))list=list.filter(n=>n.folder);
   const size=Number(u.searchParams.get('pageSize')||100),start=Number(u.searchParams.get('pageToken')||0);
   const page=list.slice(start,start+size).map(n=>this.meta(n));return {status:200,json:{files:page,nextPageToken:start+size<list.length?String(start+size):undefined}};
  }
  const m=p.match(/^\/files\/([^/]+)$/);if(m){const e=this.check(m[1]);if(e)return e;const n=this.nodes.get(m[1]);if(!n)return {status:404,json:{error:{code:404,errors:[{reason:'notFound'}]}}};return {status:200,json:this.meta(n)}}
  throw Error('unexpected '+url);
 };
 // providerBytes double: honours Range like Google (206) unless ignoreRange; never returns more than maxBytes.
 bytes=async(url,{headers={},maxBytes}={})=>{
  if(this.offline)throw new AppError('PROVIDER_NETWORK','Нет связи с провайдером.',502);
  const u=new URL(url),id=u.pathname.split('/').pop();this.calls.push(url);
  const e=this.check(id);if(e)return {status:e.status,bytes:Buffer.alloc(0),truncated:false,json:e.json};
  const n=this.nodes.get(id);if(!n)return {status:404,bytes:Buffer.alloc(0),truncated:false,json:{error:{code:404}}};
  if(!n.canDownload)return {status:403,bytes:Buffer.alloc(0),truncated:false,json:{error:{errors:[{reason:'cannotDownloadFile'}]}}};
  const content=i=>i<(n.header?.length||0)?n.header[i]:0;
  const [s,end]=this.ignoreRange?[0,n.size-1]:headers.Range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
  const last=Math.min(end,n.size-1),length=Math.min(last-s+1,maxBytes);const out=Buffer.alloc(Math.max(0,length));for(let i=0;i<out.length;i++)out[i]=content(s+i);
  this.media.push({id,start:s,bytes:out.length});return {status:this.ignoreRange?200:206,bytes:out,truncated:length<last-s+1,json:null};
 };
}
