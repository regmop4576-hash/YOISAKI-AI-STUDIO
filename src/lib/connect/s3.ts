import {createHash,createHmac} from 'node:crypto';
function sha(v:string){return createHash('sha256').update(v).digest('hex')}
function hmac(key:Buffer|string,msg:string){return createHmac('sha256',key).update(msg).digest()}
function encoded(x:string){return encodeURIComponent(x).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())}
export function objectKey(job:string,index:number){return `results/${job}/${index}.png`}
export function signedObject(key:string,method:'GET'|'PUT',ttl=300){
 const endpoint=process.env.OBJECT_STORE_ENDPOINT, bucket=process.env.OBJECT_STORE_BUCKET,region=process.env.OBJECT_STORE_REGION||'us-east-1',access=process.env.OBJECT_STORE_ACCESS_KEY,secret=process.env.OBJECT_STORE_SECRET_KEY;
 if(!endpoint||!bucket||!access||!secret)throw Error('Object storage is not configured');
 const base=new URL(endpoint);if(base.protocol!=='https:'&&base.hostname!=='localhost')throw Error('HTTPS object endpoint required');
 const now=new Date(),date=now.toISOString().replace(/[:-]|\.\d{3}/g,'').slice(0,15)+'Z',short=date.slice(0,8),scope=`${short}/${region}/s3/aws4_request`;
 const path='/'+[bucket,...key.split('/')].map(encoded).join('/');const query:Record<string,string>={'X-Amz-Algorithm':'AWS4-HMAC-SHA256','X-Amz-Credential':`${access}/${scope}`,'X-Amz-Date':date,'X-Amz-Expires':String(ttl),'X-Amz-SignedHeaders':'host'};
 const canonicalQuery=Object.entries(query).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>encoded(k)+'='+encoded(v)).join('&');const host=base.host;const canonical=[method,path,canonicalQuery,`host:${host}\n`,'host','UNSIGNED-PAYLOAD'].join('\n');const stringToSign=['AWS4-HMAC-SHA256',date,scope,sha(canonical)].join('\n');
 const signature=createHmac('sha256',hmac(hmac(hmac(hmac('AWS4'+secret,short),region),'s3'),'aws4_request')).update(stringToSign).digest('hex');
 return base.origin+path+'?'+canonicalQuery+'&X-Amz-Signature='+signature;
}
