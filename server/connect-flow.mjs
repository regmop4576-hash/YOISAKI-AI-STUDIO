// v1.7.3 connection phases and component diagnostics, derived only from what the local app really observed
// (error codes of requestUpstream / validateHealth and the engine's /health answer). Nothing is guessed:
// a component that was not reached is UNKNOWN, not READY.
export const PHASES=['OFFLINE','STARTING','CONNECTING','AUTHENTICATING','LOADING','READY','ERROR'];
export const COMPONENTS=['frontend','tunnel','auth','engine','gpu','models'];
// retry: worth waiting for (server still booting, tunnel not yet up). discover: the address itself may be stale.
const RULES={
 DNS_ERROR:{component:'tunnel',retry:true,discover:true,message:'Адрес сервера пока не находится в DNS: GPU-инстанс выключен, туннель ещё создаётся или адрес сменился.'},
 DNS_TIMEOUT:{component:'tunnel',retry:true,discover:true,message:'DNS не ответил вовремя. Проверьте интернет на телефоне.'},
 TUNNEL_OFFLINE:{component:'tunnel',retry:true,discover:true,message:'Cloudflare отвечает, но GPU-сервер к туннелю не подключён: инстанс выключен или ещё запускается.'},
 TUNNEL_UNAVAILABLE:{component:'tunnel',retry:true,discover:true,message:'Туннель недоступен: GPU-сервер выключен, ещё запускается или связь прервалась.'},
 CONNECTION_TIMEOUT:{component:'tunnel',retry:true,message:'GPU-сервер не ответил вовремя.'},
 UPSTREAM_INTERRUPTED:{component:'tunnel',retry:true,message:'Соединение с GPU-сервером прервалось.'},
 TLS_ERROR:{component:'tunnel',retry:true,message:'Защищённое соединение с туннелем не установлено.'},
 ORIGIN_UNREACHABLE:{component:'engine',retry:true,message:'Туннель работает, но движок за ним не отвечает: он ещё запускается или остановлен.'},
 UPSTREAM_HTTP:{component:'engine',retry:true,message:'Туннель работает, но движок отвечает ошибкой: он ещё запускается или остановлен.'},
 INVALID_RESPONSE:{component:'engine',retry:true,message:'По адресу отвечает не движок YOISAKI (возможно, страница ошибки туннеля). Жду запуска движка.'},
 AUTH_REJECTED:{component:'auth',retry:false,message:'Сервер отклонил токен: на GPU сменили токен (ротация) или по этому адресу другой сервер. Вставьте новую ссылку один раз.'},
 GPU_NOT_READY:{component:'gpu',retry:false,message:'Движок отвечает, но CUDA/GPU недоступны. Проверьте инстанс: ./check-cloudcompute.sh (CloudCompute) или среду T4 (Colab).'},
 ENGINE_UPGRADE_REQUIRED:{component:'engine',retry:false,message:'Версия движка несовместима: нужен YOISAKI ENGINE 1.7.0 с ControlNet, SDPose и Img2Img.'},
 PRIVATE_DESTINATION:{component:'tunnel',retry:false,message:'Адрес указывает на частную сеть. Нужен публичный HTTPS-адрес.'},
 REDIRECT_REJECTED:{component:'tunnel',retry:false,message:'Адрес перенаправляет запрос (например, на страницу входа). Нужен прямой адрес движка.'},
 PROXY_DENIED:{component:'tunnel',retry:false,message:'Запрос к этому адресу запрещён политикой безопасности.'},
 INVALID_URL:{component:'tunnel',retry:false,message:'Неверный адрес сервера.'},
 INVALID_TOKEN:{component:'auth',retry:false,message:'Неверный токен в ссылке.'},
};
export function classify(code){return RULES[code]||{component:'engine',retry:false,message:''}}
const ORDER=['tunnel','auth','engine','gpu','models'];
// state/info/code/models come from the local app's own status; returns {frontend,tunnel,auth,engine,gpu,models}.
export function components({phase,info,code,modelsCount,modelsError,usableCheckpoints}){
 const out={frontend:'READY',tunnel:'UNKNOWN',auth:'UNKNOWN',engine:'UNKNOWN',gpu:'UNKNOWN',models:'UNKNOWN'};
 if(info&&['READY','BUSY','LOADING'].includes(info.state)){
  Object.assign(out,{tunnel:'READY',auth:'READY',engine:info.state==='LOADING'?'WAITING':'READY',gpu:info.gpu_name?'READY':'ERROR'});
  out.models=modelsError?'WARNING':!modelsCount?'WARNING':usableCheckpoints?'READY':'WARNING';
  return out;
 }
 if(phase==='OFFLINE'||!code&&phase!=='ERROR')return {...out,...(phase==='STARTING'||phase==='CONNECTING'?{tunnel:'WAITING'}:{})};
 // v1.7.3: a CloudCompute API error (instance not running, key rejected) says nothing about tunnel or engine.
 if(String(code).startsWith('CC_'))return out;
 const rule=classify(code);const failed=ORDER.indexOf(rule.component);
 // AUTH_REJECTED proves the tunnel answered; engine errors behind the tunnel prove nothing about auth.
 for(let i=0;i<failed;i++)if(!(rule.component==='engine'&&ORDER[i]==='auth'))out[ORDER[i]]='READY';
 if(failed>=0)out[rule.component]=phase==='ERROR'?'ERROR':'WAITING';
 return out;
}
