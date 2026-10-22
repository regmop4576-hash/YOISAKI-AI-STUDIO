import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
export const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export const token=()=>randomBytes(32).toString('base64url');
export function equals(a:string,b:string){const x=Buffer.from(a);const y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)}
export function sessionValue(){const secret=process.env.SESSION_SECRET;if(!secret||secret.length<32)throw Error('SESSION_SECRET missing');const day=Math.floor(Date.now()/86400000);const content=`owner.${day}`;return `${content}.${createHmac('sha256',secret).update(content).digest('hex')}`}
export function validSession(v?:string){if(!v)return false;const secret=process.env.SESSION_SECRET;if(!secret)return false;const [owner,day,signature]=v.split('.');if(owner!=='owner'||!day||!signature||!/^\d+$/.test(day))return false;if(Math.abs(Math.floor(Date.now()/86400000)-Number(day))>1)return false;return equals(createHmac('sha256',secret).update(`${owner}.${day}`).digest('hex'),signature)}
