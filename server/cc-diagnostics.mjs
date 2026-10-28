// v1.7.7 downloadable CloudCompute diagnostics (YOISAKI_CLOUDCOMPUTE_DIAGNOSTICS.json). Built only from what this app
// observed; anything it could not observe is "unavailable", never guessed. Credentials never enter the report: the
// deployment token, the CloudCompute key, Google tokens and the engine link are dropped by key AND every string is
// scrubbed for token-like patterns as a second barrier.
export const DIAGNOSTICS_FILENAME='YOISAKI_CLOUDCOMPUTE_DIAGNOSTICS.json';
export const UNAVAILABLE='unavailable';
const SECRET_KEY=/(^|_)(token|tokens|secret|client_secret|password|passwd|authorization|api_?key|key|cloud_key|refresh_token|access_token|private_key|cookie|credentials?|onstart|sig|link)($|_)/i;
const PATTERNS=[
 [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,'[REDACTED_PRIVATE_KEY]'],
 [/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi,'Bearer [REDACTED]'],
 [/\bcc-[A-Za-z0-9._~-]{8,}/g,'[REDACTED_CC_KEY]'],
 [/\bya29\.[A-Za-z0-9._-]+/g,'[REDACTED_GOOGLE_TOKEN]'],
 [/\b1\/\/[A-Za-z0-9._-]{10,}/g,'[REDACTED_GOOGLE_REFRESH]'],
 [/\bGOCSPX-[A-Za-z0-9_-]+/g,'[REDACTED_CLIENT_SECRET]'],
 [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,'[REDACTED_JWT]'],
 [/\bgh[pousr]_[A-Za-z0-9]{20,}/g,'[REDACTED_GITHUB_TOKEN]'],
 [/#token=[^\s"']+/g,'#token=[REDACTED]'],
 [/\b[a-f0-9]{64}\b/gi,'[REDACTED_64HEX]'],
];
export function scrubText(value,max=600){let s=String(value).replace(/[\x00-\x08\x0b-\x1f]/g,' ');for(const [re,to] of PATTERNS)s=s.replace(re,to);return s.slice(0,max)}
export function sanitize(value,depth=0){
 if(depth>8)return '[TRUNCATED]';
 if(typeof value==='string')return scrubText(value);
 if(typeof value==='number'||typeof value==='boolean'||value===null)return value;
 if(Array.isArray(value))return value.slice(0,60).map(v=>sanitize(v,depth+1));
 if(value&&typeof value==='object'){const out={};for(const [k,v] of Object.entries(value)){if(SECRET_KEY.test(k)&&!/^(token_present|terminal)$/.test(k))continue;if(v!==undefined)out[k]=sanitize(v,depth+1)}return out}
 return null;
}
const or=(v,fallback=UNAVAILABLE)=>v===undefined||v===null||v===''?fallback:v;
const iso=t=>Number.isFinite(t)&&t>0?new Date(t).toISOString():UNAVAILABLE;

export function diagnosticsReport({websiteVersion,edition,deployment,image,connection,monitor,now=Date.now()}){
 const d=deployment||null,info=connection?.info||null,live=!!connection?.connected;
 const host=u=>{try{return new URL(u).hostname}catch{return UNAVAILABLE}};
 const report={
  report:'YOISAKI_CLOUDCOMPUTE_DIAGNOSTICS',format_version:2,generated_at:iso(now),
  website:{version:or(websiteVersion),edition:or(edition)},
  engine:{version:live?or(info?.engine_version):UNAVAILABLE,api_version:live?or(info?.api_version):UNAVAILABLE,deploy_version:live?or(info?.deploy_version):UNAVAILABLE,
   health:{state:or(connection?.state),phase:or(connection?.phase),last_code:or(connection?.code,null),last_error:or(connection?.error,null),checked:live}},
  instance:d?{id:d.instance_id,pending_confirmation:String(d.instance_id).startsWith('pending-'),name:or(d.name),created_at:iso(d.created_at),adopted:!!d.adopted,
   provider_status:or(d.instance_status),raw_provider_status:d.provider?.raw_status??UNAVAILABLE,provider_phase:or(d.provider?.phase),provider_fields:d.provider?.fields||{},provider_message:or(d.provider?.message,null),provider_checked_at:iso(d.provider?.checked_at),
   offer:d.offer||UNAVAILABLE,disk_gb:or(d.disk_gb),bootstrap_profile:or(d.bootstrap_profile,'not recorded (created before 1.7.7 or adopted)'),
   terminal:d.terminal||{state:'UNKNOWN',message:'not checked'}}:UNAVAILABLE,
  gpu:{model:live&&info?.gpu_name?info.gpu_name:or(d?.offer?.gpu),model_source:live&&info?.gpu_name?'engine /health':d?.offer?.gpu?'CloudCompute offer (advertised)':UNAVAILABLE,
   vram_total_mb:live&&info?.vram_total_mb!=null?info.vram_total_mb:or(d?.offer?.vram_mb),vram_source:live&&info?.vram_total_mb!=null?'engine /health':d?.offer?.vram_mb!=null?'CloudCompute offer (advertised)':UNAVAILABLE,
   vram_available_mb:live?or(info?.vram_available_mb):UNAVAILABLE,driver:live?or(info?.driver_version||info?.nvidia_driver):UNAVAILABLE,cuda_runtime:live?or(info?.cuda_version||info?.torch_cuda):UNAVAILABLE},
  image:{reference:or(d?.image||image?.image),verification:image?{checked:image.checked,publicly_accessible:image.accessible,linux_amd64:or(image.linux_amd64,null),message:image.message,checked_at:iso(image.checked_at)}:UNAVAILABLE},
  initialization:d?{stage:d.stage,stage_message:d.stage_message||'',stage_at:iso(d.stage_at),last_verified_stage:or(d.last_verified_stage,d.stage),
   instance_running:d.provider?.phase==='RUNNING',engine_ready:live&&connection?.phase==='READY',
   provisioning_requested:d.initialization?.requested??UNAVAILABLE,
   provisioning_completed:d.initialization?.snapshot?.provisioning_completed??(d.gpu_stages?.some(s=>s.stage==='PROVISIONED')?true:UNAVAILABLE),
   supervisor_confirmed:d.initialization?.snapshot?.supervisor_confirmed??d.initialization?.supervisor_confirmed??(d.gpu_stages?.some(s=>s.stage==='SUPERVISOR_STARTED')?true:UNAVAILABLE),
   required_directories:d.initialization?.snapshot?.directories??UNAVAILABLE,
   startup:d.initialization||UNAVAILABLE,
   stage_history:(d.stage_history||[]).map(h=>({stage:h.stage,at:iso(h.at),source:h.source,provider_status:h.provider_status||''})),
   engine_signals:(d.gpu_stages||[]).map(s=>({stage:s.stage,at:iso(s.ts*1000)})),failure:d.failure||null,error:d.error||null}:UNAVAILABLE,
  error_codes:[d?.failure?.code,connection?.code].filter(Boolean),
  connectivity:{connected:live,provider:or(connection?.provider),engine_host:live?host(connection.origin):d?.url?host(d.url):UNAVAILABLE,engine_address_published:!!d?.url,watching:!!d?.watching},
  gpu_monitor:monitor?{updated_at:iso(monitor.updated_at),offers:monitor.total,matching:monitor.matching,error:monitor.error,rate_limit:monitor.rate_limit,auto:monitor.auto?.on===true,requests:monitor.requests}:UNAVAILABLE,
  not_included:'CloudCompute API key, engine token, Google OAuth tokens, SSH keys, authorization headers and the onstart script are never included.',
 };
 return sanitize(report);
}
