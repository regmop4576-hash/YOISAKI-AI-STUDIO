import {fail} from './errors.mjs';

export const PROVIDERS=['colab','cloudcompute'];
export function providerName(value){
 if(!PROVIDERS.includes(value))fail('INVALID_PROVIDER','Выберите Google Colab или CloudCompute.');
 return value;
}
export function validHost(host,provider='colab'){
 if(provider==='colab')return /^[-a-z0-9]+\.trycloudflare\.com$/.test(host);
 // Explicit public HTTPS DNS endpoint. DNS is checked and pinned for every request.
 return provider==='cloudcompute'&&host.length<=253&&host.includes('.')&&host.split('.').every(x=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x))&&!/^\d+(\.\d+){3}$/.test(host)&&!/(^|\.)(localhost|local|internal|test|invalid)$/.test(host);
}
export function endpoint(raw,provider){
 providerName(provider);
 if(typeof raw!=='string'||raw.length>1000)fail('INVALID_URL','Введите HTTPS URL сервера.');
 if(!raw.trim())return '';
 let u;try{u=new URL(raw.trim())}catch{fail('INVALID_URL','Неверный HTTPS URL сервера.')}
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash||!validHost(u.hostname,provider))fail('INVALID_URL','Нужен HTTPS URL без пути, параметров и токена. Colab: *.trycloudflare.com; CloudCompute: публичный DNS-адрес HTTPS сервера (порт 443).');
 return u.origin;
}
export function providerConfig(preferences){
 const old=preferences?.gpu;
 const clean=(raw,p)=>{try{return endpoint(raw||'',p)}catch{return ''}};
 return {selected:PROVIDERS.includes(old?.selected)?old.selected:'colab',endpoints:{colab:clean(old?.endpoints?.colab??preferences?.last_host,'colab'),cloudcompute:clean(old?.endpoints?.cloudcompute,'cloudcompute')}};
}
