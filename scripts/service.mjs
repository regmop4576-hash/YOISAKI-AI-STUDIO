import {checkBuild} from './build-identity.mjs';
import {WEBSITE_VERSION,STUDIO_EDITION} from '../server/release.mjs';
import {randomBytes} from 'node:crypto';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import net from 'node:net';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),data=process.env.YOISAKI_DATA_DIR||path.join(os.homedir(),'.local/share/yoisaki-ai-studio');
await fs.mkdir(data,{recursive:true,mode:0o700});const runtime=path.join(data,'runtime.json'),log=path.join(data,'server.log');
async function record(){try{return JSON.parse(await fs.readFile(runtime,'utf8'))}catch{return null}}
async function ours(r){
 if(!r?.pid)return false;
 try{process.kill(r.pid,0)}catch{return false}
 try{const response=await fetch(`http://127.0.0.1:${r.port}/_yoisaki/service`,{headers:{'X-Yoisaki-Service':r.serviceKey||''},signal:AbortSignal.timeout(1000)});if(response.ok&&(await response.json()).pid===r.pid)return true}catch{}
 try{const cmd=await fs.readFile(`/proc/${r.pid}/cmdline`,'utf8');return cmd.split('\0').includes(path.join(r.root,'server/index.mjs'))}catch{return false}
}
const action=process.argv[2];
if(action==='start'){
 try{await checkBuild()}catch(e){console.error(e.message);process.exit(1)}
 const old=await record();if(await ours(old)){console.error(`Сервер уже работает из ${old.root}. Для запуска обновлённого кода: bash stop.sh, затем bash start.sh.`);process.exit(1)}
 const port=Number(process.env.PORT||3000);if(!Number.isInteger(port)||port<1024||port>65535){console.error('PORT должен быть числом 1024–65535.');process.exit(1)}
 const available=await new Promise(resolve=>{const s=net.createServer();s.once('error',()=>resolve(false));s.listen(port,'127.0.0.1',()=>s.close(()=>resolve(true)))});
 if(!available){console.error(`Порт ${port} занят. Остановите другой сервер или запустите PORT=3001 ./start.sh`);process.exit(1)}
 const serviceKey=randomBytes(32).toString('hex');const h=await fs.open(log,'a',0o600);const child=spawn(process.execPath,[path.join(root,'server/index.mjs')],{cwd:root,env:{...process.env,YOISAKI_DATA_DIR:data,PORT:String(port),YOISAKI_SERVICE_KEY:serviceKey},detached:true,stdio:['ignore',h.fd,h.fd]});await h.close();child.unref();
 await fs.writeFile(runtime,JSON.stringify({pid:child.pid,root,port,serviceKey}),{mode:0o600});
 let ok=false;for(let i=0;i<40;i++){try{const r=await fetch(`http://127.0.0.1:${port}/api/session`,{headers:{'X-Yoisaki-Local':'1'},signal:AbortSignal.timeout(1000)});if(r.ok){ok=true;break}}catch{}await new Promise(r=>setTimeout(r,250))}
 if(!ok){console.error('Сервер не запустился. Выполните ./diagnostics.sh');if(await ours(await record()))process.kill(child.pid,'SIGTERM');process.exitCode=1}else console.log(`YOISAKI AI STUDIO v${WEBSITE_VERSION} ${STUDIO_EDITION}\nОткройте: http://127.0.0.1:${port}\nОстановка: ./stop.sh\nНе закрывайте принудительно Termux во время генерации.`);
}else if(action==='stop'){
 const r=await record();if(!await ours(r)){console.log('Приложение уже остановлено.');await fs.rm(runtime,{force:true});process.exit(0)}
 process.kill(r.pid,'SIGTERM');for(let i=0;i<50&&await ours(r);i++)await new Promise(x=>setTimeout(x,200));if(await ours(r))process.kill(r.pid,'SIGKILL');await fs.rm(runtime,{force:true});console.log('Приложение остановлено. Данные сохранены.');
}else if(action==='diagnostics'){
 const r=await record();console.log(`YOISAKI ${WEBSITE_VERSION}\nNode: ${process.version}\nПлатформа: ${process.platform}/${process.arch}\nTermux: ${!!process.env.PREFIX?.includes('com.termux')}\nСервер: ${await ours(r)?'работает':'остановлен'}`);
 try{const identity=await checkBuild();console.log('Сборка соответствует исходникам: '+identity.source_sha256)}catch{console.log('Сборка устарела или повреждена: выполните bash install.sh.')}
 if(await ours(r)){try{const response=await fetch(`http://127.0.0.1:${r.port}/_yoisaki/service`,{headers:{'X-Yoisaki-Service':r.serviceKey||''},signal:AbortSignal.timeout(1000)});console.log('Версия запущенного сервера: '+((await response.json()).version||'не сообщается (старый сервер)'));console.log('Папка запущенного сервера: '+r.root)}catch{console.log('Версия запущенного сервера недоступна.')}}
 try{const s=await fs.stat(path.join(data,'state.json'));console.log('Хранилище: '+s.size+' байт')}catch{console.log('Хранилище ещё не создано.')}
 try{const text=await fs.readFile(log,'utf8');console.log(text.slice(-4000).replace(/(?:Bearer\s+|#token=)[^\s"']+/gi,'[СКРЫТО]').replace(/[a-f0-9]{64}/g,'[СКРЫТО]'))}catch{}
}else{console.error('Используйте start, stop или diagnostics');process.exitCode=1}
