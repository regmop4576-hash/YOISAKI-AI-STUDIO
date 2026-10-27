// v1.7.3 Easy Connect in real Chromium (mobile 360/390/430) with production assets and the local Node server.
// MOCKED: CloudCompute API, Google OAuth/Drive and the GPU engine are test doubles; no real account is used.
import {chromium} from '@playwright/test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createLocalApp} from '../server/app.mjs';import {AppError} from '../server/errors.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'easy-browser-'));const token='c'.repeat(64);const KEY='cc-BROWSERTEST_KEY_abcdefghij';
await fs.writeFile(path.join(dir,'cloudcompute-api.json'),JSON.stringify({version:1,verified_against:'TEST FIXTURE — not the real CloudCompute API',operations:{list:{method:'GET',path:'/instances',items:'data'},get:{method:'GET',path:'/instances/{id}',item:'data'},start:{method:'POST',path:'/instances/{id}/start'},stop:{method:'POST',path:'/instances/{id}/stop'}},
 fields:{id:'id',name:'name',status:'state',gpu:'gpu',price_per_hour:'price',disk_gb:'disk'},status_map:{running:'RUNNING',stopped:'STOPPED',starting:'STARTING'}}));
const inst={id:'i-1',name:'RTX 3090 · test double',state:'stopped',gpu:'RTX 3090',price:25,disk:100};const cloudCalls=[];
const ccRequest=async o=>{cloudCalls.push(o.method+' '+o.path);if(o.headers.Authorization!=='Bearer '+KEY)return {status:401,json:{}};
 if(o.path==='/api/v1/instances')return {status:200,json:{data:[inst]}};if(o.path==='/api/v1/instances/i-1'){if(inst.state==='starting')inst.state='running';return {status:200,json:{data:inst}}}
 if(o.path==='/api/v1/instances/i-1/start'){inst.state='starting';return {status:200,json:{}}}return {status:404,json:{}}};
const health={engine:'YOISAKI_ENGINE',engine_version:'1.7.0',api_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true},state:'READY',gpu_name:'SYNTHETIC GPU',vram_total_mb:24000,vram_available_mb:22000};
const F=n=>'folder'+String(n).padStart(6,'0');
const tree={root:[[F(1),'YOISAKI_AI_STUDIO',1]],[F(1)]:[[F(2),'models',1]],[F(2)]:[[F(3),'checkpoints',1],[F(4),'loras',1],[F(5),'controlnet',1]],[F(3)]:[['file000001','wai.safetensors',0,6.9e9]],[F(4)]:[['file000002','Amber_Nova.safetensors',0,2.2e8],['file000003','Vesper_Nova.safetensors',0,2.1e8]],[F(5)]:[]};
const meta={[F(1)]:['YOISAKI_AI_STUDIO','0AROOTFOLDER1'],[F(2)]:['models',F(1)],'0AROOTFOLDER1':['My Drive',null]};
const driveRequest=async o=>{const u=new URL('https://x'+o.path);const q=u.searchParams.get('q')||'';
 if(u.pathname==='/drive/v3/about')return {status:200,json:{user:{displayName:'Browser Test',emailAddress:'browser.test@example.com'}}};
 if(u.pathname==='/drive/v3/files'){const parent=(q.match(/'([^']+)' in parents/)||[])[1];return {status:200,json:{files:(tree[parent]||[]).filter(r=>!q.includes('mimeType=')||r[2]).map(([id,name,folder,size])=>({id,name,mimeType:folder?'application/vnd.google-apps.folder':'x',...(size?{size:String(size)}:{})}))}}}
 const m=u.pathname.match(/^\/drive\/v3\/files\/(\w+)$/);if(m&&meta[m[1]]){const [name,parent]=meta[m[1]];return {status:200,json:{id:m[1],name,mimeType:'application/vnd.google-apps.folder',...(parent?{parents:[parent]}:{})}}}
 return {status:404,json:{}}};
const googlePost=async(form,o={})=>o.route==='/revoke'?{status:200,json:{}}:{status:200,json:{access_token:'ya29.BROWSERTEST_ACCESS',expires_in:3600}};
const exchange=async()=>({access_token:'ya29.BROWSERTEST_ACCESS',token_type:'Bearer',refresh_token:'1//BROWSERTEST_REFRESH_abcdefghijkl',expiry:new Date(Date.now()+3600e3).toISOString()});
const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),sleep:async()=>{},ccRequest,driveRequest,googlePost,exchange,env:{YOISAKI_GOOGLE_CLIENT_ID:'123456789-browsertest.apps.googleusercontent.com',YOISAKI_GOOGLE_CLIENT_SECRET:'GOCSPX-browsertest'},
 upstream:async(c,route)=>{assert.equal(c.token,token);if(route==='/health')return health;if(route==='/inventory?models=1')return {revision:'1'.repeat(32),models:[]};if(route==='/sync/status')throw new AppError('DRIVE_SYNC_UNAVAILABLE','нет',409);throw new AppError('JOB_NOT_FOUND','404',404)}});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
const session=await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}});const cookie=session.headers.get('set-cookie').split(';')[0];
const local=(route,body)=>fetch(base+route,{method:'POST',headers:{'X-Yoisaki-Local':'1',cookie,'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
const dialogs=[];page.on('dialog',d=>{dialogs.push(d.message());void d.accept()});
const button=name=>page.getByRole('button',{name,exact:true});const noOverflow=()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
const widths=async label=>{for(const width of [360,390,430]){await page.setViewportSize({width,height:844});assert.equal(await noOverflow(),true,label+' overflow '+width)}await page.setViewportSize({width:390,height:844})};
try{
 await fs.mkdir('validation',{recursive:true});
 // ---- GPU page: CloudCompute API key, instance, CONNECT GPU ----
 await local('/api/gpu/provider',{provider:'cloudcompute'});
 await local('/api/gpu/connect',{provider:'cloudcompute',url:'https://gpu.example.com/#token='+token,remember:true});await local('/api/gpu/disconnect',{});
 await page.goto(base+'/engine');await page.getByText('CloudCompute API',{exact:true}).waitFor();
 const keyField=page.getByLabel('Ключ CloudCompute API');assert.equal(await keyField.getAttribute('type'),'password');
 await keyField.fill(KEY);await button('Сохранить ключ').click();await page.getByText('RTX 3090 · test double').waitFor();
 assert.equal(await keyField.count(),0,'the key field is gone after saving');await page.getByText(/Ключ сохранён и проверен/).waitFor();
 await page.getByRole('radio').first().click();await page.getByRole('radio',{checked:true}).waitFor();await page.getByText('Остановлен',{exact:true}).waitFor();
 await widths('engine');await page.screenshot({path:'validation/easy-gpu-api-ru.png',fullPage:true});
 await button('ПОДКЛЮЧИТЬ GPU').click();
 await page.getByText('Версия движка: 1.7.0',{exact:true}).waitFor({timeout:20000});
 assert(dialogs.some(d=>d.includes('начинается оплата GPU')),'billing confirmation before start');assert.equal(cloudCalls.filter(c=>c.startsWith('POST')).length,1);
 await page.getByText('ПОДКЛЮЧЁН',{exact:true}).first().waitFor();await page.screenshot({path:'validation/easy-gpu-ready-ru.png',fullPage:true});
 await local('/api/gpu/disconnect',{});
 // ---- Models page: Google sign-in, folder picker, preview (no GPU) ----
 await page.goto(base+'/models');await page.getByRole('heading',{name:'GOOGLE DRIVE',exact:true}).waitFor();await page.getByText('Офлайн',{exact:true}).waitFor();
 let googleUrl='';await page.route('https://accounts.google.com/**',r=>{googleUrl=r.request().url();void r.fulfill({status:200,contentType:'text/html',body:'<p>google</p>'})});
 await button('Войти через Google').click();await page.waitForURL(/accounts\.google\.com/);
 const state=new URL(googleUrl).searchParams.get('state');assert(state&&!googleUrl.includes('GOCSPX'));
 await page.goto(base+'/?state='+state+'&code=browser-code');  // Google's redirect back to the loopback address
 await page.getByText('browser.test@example.com').first().waitFor();await page.getByText(/Выберите папку с моделями/).waitFor();
 await page.getByRole('button',{name:/YOISAKI_AI_STUDIO/}).click();await page.getByRole('button',{name:/^models/}).click();await button('Выбрать «models»').click();
 await page.getByText('Мой диск/YOISAKI_AI_STUDIO/models').waitFor();await page.getByText(/Папка controlnet\/ не синхронизируется/).waitFor();
 assert.match(await page.locator('[aria-label="Модели в папке Google Drive"]').innerText(),/LoRA: 2/);
 await page.getByText('Недоступна: нужен CloudCompute онлайн').waitFor();
 await widths('models');await page.screenshot({path:'validation/easy-drive-ru.png',fullPage:true});
 // English
 await button('Настройки').first().click();await page.getByRole('dialog').locator('select').selectOption('English');await page.getByRole('button',{name:'Close',exact:true}).click();
 for(const name of ['Change folder','Check models in Drive','Disconnect Google Drive'])assert.equal(await button(name).count(),1,name);
 await page.getByText('Model synchronization',{exact:false}).first().waitFor();await widths('models en');await page.screenshot({path:'validation/easy-drive-en.png',fullPage:true});
 await page.goto(base+'/engine');for(const name of ['Validate key','Replace key','Remove key','CONNECT GPU'])await button(name).waitFor();await widths('engine en');
 // Secrets: not in page text, browser storage or state.json.
 const text=await page.content()+await (await page.goto(base+'/models'))?.text();const storage=JSON.stringify(await page.evaluate(()=>({...localStorage,...sessionStorage})));const st=await fs.readFile(path.join(dir,'state.json'),'utf8');
 for(const leak of ['BROWSERTEST_KEY','BROWSERTEST_REFRESH','BROWSERTEST_ACCESS','GOCSPX-browsertest',token])assert(!text.includes(leak)&&!storage.includes(leak)&&!st.includes(leak),leak);
 assert.deepEqual(errors,[]);
 console.log('PASS: CloudCompute API key (password field, never shown again), instance list/select, CONNECT GPU with billing confirmation → instance start → engine READY; Google sign-in without GPU, account, folder picker, preview (nested LoRA, controlnet note), separate Drive/GPU/sync states, RU/EN, 360/390/430px no overflow, no secrets in page/storage/state. MOCKED services.');
}catch(e){console.error('Page text at failure:\n'+(await page.locator('main').innerText().catch(()=>'')).slice(0,3000));throw e}finally{await browser.close();await app.close();await fs.rm(dir,{recursive:true,force:true})}
