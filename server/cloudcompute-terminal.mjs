import {randomBytes} from 'node:crypto';
import {AppError} from './errors.mjs';
import {sanitize} from './cc-diagnostics.mjs';
import {onstartScript} from './cloudcompute-deploy.mjs';

// Official CloudCompute terminal-token endpoint + upstream ttyd protocol (subprotocol 'tty').
// Only TLS on CloudCompute-owned hosts is accepted. A different provider proxy/protocol fails visibly;
// never guess credentials, downgrade TLS or execute against an arbitrary host.
export function terminalUrl(value){
 let u;try{u=new URL(value)}catch{}
 if(!u||u.protocol!=='wss:'||u.username||u.password||u.hash||!/(^|\.)cloudcompute\.ru$/.test(u.hostname)||u.port&&u.port!=='443')
  throw new AppError('CC_TERMINAL_URL','CloudCompute вернул неподдерживаемый адрес терминала. Используйте команду в веб-терминале панели.',502);
 return u.href;
}
export async function initializeTerminal({cloud,instanceId,image,token,WebSocketImpl=globalThis.WebSocket,timeout=45000}){
 const session=await cloud.terminalSession(instanceId);
 const url=terminalUrl(session?.ws_url);
 if(typeof WebSocketImpl!=='function')throw new AppError('CC_TERMINAL_RUNTIME','Для автоматического запуска требуется Node.js 22+ с WebSocket.',500);
 const nonce=randomBytes(12).toString('hex'),ready='Y_READY_'+nonce,done='Y_DONE_'+nonce,delimiter='Y_SCRIPT_'+nonce;
 const script=onstartScript({image,token});
 return new Promise((resolve,reject)=>{
  let ws,finished=false,phase='opening',output='',total=0;
  const finish=(error,result)=>{if(finished)return;finished=true;clearTimeout(timer);try{ws?.close()}catch{};error?reject(error):resolve(result)};
  const fail=code=>finish(new AppError(code,'Автоматический запуск через веб-терминал не подтверждён. Проверьте доступность терминала или выполните резервную команду один раз.',502));
  const timer=setTimeout(()=>fail('CC_TERMINAL_TIMEOUT'),timeout);
  try{ws=new WebSocketImpl(url,['tty']);ws.binaryType='arraybuffer'}catch{return fail('CC_TERMINAL_CONNECT')}
  const send=text=>ws.send(Buffer.from('0'+text)); // ttyd INPUT = ASCII '0'; OUTPUT = '0'
  ws.addEventListener('open',()=>{
   ws.send(JSON.stringify({AuthToken:'',columns:120,rows:30}));
   phase='shell';
  });
  ws.addEventListener('message',event=>{
   if(finished)return;
   const bytes=typeof event.data==='string'?Buffer.from(event.data):Buffer.from(event.data);
   if(bytes[0]!==48)return;
   total+=bytes.length;if(total>262144)return fail('CC_TERMINAL_OUTPUT_LIMIT');
   output=(output+bytes.subarray(1).toString('utf8')).slice(-16384);
   if(phase==='shell'){
    phase='quiet';output='';
    // Confirm echo is disabled BEFORE sending the credential. Disable history; no secret command line in ps.
    // Split marker in printf so echoed input cannot be mistaken for completed execution.
    send(` stty -echo && set +o history && printf '\\nY_READY_%s\\n' '${nonce}'\n`);
   }else if(phase==='quiet'&&output.includes('\n'+ready+'\r\n')||phase==='quiet'&&output.includes('\n'+ready+'\n')){
    phase='provision';output='';
    send(`bash <<'${delimiter}'\n${script}${delimiter}\nyoisaki_rc=$?; printf '\\nY_DONE_%s:%s\\n' '${nonce}' "$yoisaki_rc"; stty echo\n`);
   }else if(phase==='provision'){
    const match=output.match(new RegExp('(?:^|[\\r\\n])'+done+':([0-9]+)(?:[\\r\\n])'));
    if(match){
     const exitCode=Number(match[1]);
     if(exitCode!==0)return finish(new AppError('CC_INIT_EXIT_'+exitCode,'Инициализация в контейнере завершилась с кодом '+exitCode+'. Проверьте образ и права записи /data; журнал /data/logs/autostart.log.',502));
     // v1.7.7 lacks the new confirmation; don't claim its supervisor was checked.
     finish(null,{method:'terminal-api',completed_at:Date.now(),exit_code:0,supervisor_confirmed:output.includes('YOISAKI_SUPERVISOR_CONFIRMED'),snapshot:readSnapshot(output)});
    }
   }
  });
  ws.addEventListener('error',()=>fail('CC_TERMINAL_CONNECT'));
  ws.addEventListener('close',()=>{if(!finished)fail('CC_TERMINAL_CLOSED')});
 });
}

function readSnapshot(output){
 const line=output.split(/[\r\n]/).find(s=>s.startsWith('YOISAKI_DIAGNOSTICS '));
 if(!line)return null;
 try{const d=JSON.parse(line.slice('YOISAKI_DIAGNOSTICS '.length));return sanitize({image_version:d.image_version,checked_at:d.checked_at,directories:d.directories,provisioning_completed:d.provisioning_completed,supervisor_confirmed:d.supervisor_confirmed,launcher_running:d.launcher_running,engine_health:d.engine_health,gpu_name:d.gpu_name,last_startup_error:d.last_startup_error})}catch{return null}
}
