import {checkBuild} from '../scripts/build-identity.mjs';
import {WEBSITE_VERSION,STUDIO_EDITION} from '../server/release.mjs';
import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import {validateClient} from './google-oauth.mjs';
import {createLocalApp} from './app.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=process.env.YOISAKI_DATA_DIR||path.join(os.homedir(),'.local/share/yoisaki-ai-studio');
const port=Number(process.env.PORT||3000);
if(!Number.isInteger(port)||port<1024||port>65535){console.error('Неверный PORT.');process.exit(1)}
try{
await checkBuild();
let defaultGoogle=null;
try{defaultGoogle=validateClient(JSON.parse(await fs.readFile(path.join(root,'config/google-desktop-client.json'),'utf8')))}catch(e){if(e.code!=='ENOENT')throw e}
const app=await createLocalApp({defaultGoogle,dataDir,distDir:path.join(root,'dist'),serviceKey:process.env.YOISAKI_SERVICE_KEY||''});
app.server.once('error',e=>{console.error(e.code==='EADDRINUSE'?`Порт ${port} занят. Остановите другой сервер или используйте PORT=3001 ./start.sh.`:'Не удалось запустить локальный сервер.');process.exitCode=1;app.close().catch(()=>{})});
app.server.listen(port,'127.0.0.1',()=>console.log(`YOISAKI AI STUDIO v${WEBSITE_VERSION} ${STUDIO_EDITION}\nОткройте http://127.0.0.1:${port}\nДля остановки: ./stop.sh`));
let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await app.close();process.exit(0)};process.on('SIGTERM',stop);process.on('SIGINT',stop);
}catch(e){console.error(e.status?e.message:'Проверьте сборку (bash install.sh) и хранилище (bash diagnostics.sh).');process.exitCode=1}
