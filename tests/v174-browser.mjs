// Real Chromium + real local HTTP app; Google, CloudCompute and GPU are explicit test doubles.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLocalApp} from '../server/app.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-browser-174-'));
const client={client_id:'123456789-abcdefghij.apps.googleusercontent.com',client_secret:'GOCSPX-test_secret'};
let bound=null,apiFail=false;
const sync=()=>({service:'YOISAKI_DRIVE_SYNC',enabled:true,rclone_available:true,configured:!!bound,source:'models',scope:'drive.readonly',connection:{state:'UNKNOWN'},job:null,items:[],inventory_revision:0,folder_selection:true});
const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),defaultGoogle:client,
 exchange:async()=>({access_token:'test-private-access',refresh_token:'test-private-refresh',expiry:'2099-01-01T00:00:00Z'}),
 providerRequest:async(url,opts)=>{if(url.includes('cloudcompute.ru'))return apiFail?{status:429,json:{error:{message:'Rate limited'}}}:{status:200,json:{data:[{id:17,name:'YOISAKI GPU',status:'running',gpu_name:'RTX test'}]}};
 if(url.includes('/about?'))return {status:200,json:{user:{emailAddress:'test@example.invalid',displayName:'Test'}}};
 if(url.includes('/files?'))return {status:200,json:{files:[{id:'chosen-models',name:'My models'}]}};
 return {status:200,json:{id:'chosen-models',name:'My models',mimeType:'application/vnd.google-apps.folder'}}},
 upstream:async(c,p,o)=>{if(p==='/health')return {engine:'YOISAKI_ENGINE',engine_version:'1.7.0',api_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true},state:'READY',gpu_name:'Mock GPU',vram_total_mb:16000,vram_available_mb:15000};if(p.startsWith('/inventory'))return {revision:'a'.repeat(32),models:[]};if(p==='/sync/drive/connect'){bound=JSON.parse(o.body);return sync()}if(p==='/sync/status')return sync();throw Error(p)}
});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--no-zygote','--single-process']});
const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('https://accounts.google.com/**',async route=>{const state=new URL(route.request().url()).searchParams.get('state');await route.fulfill({status:302,headers:{location:base+'/?state='+state+'&code=browser-mock'},body:''})});
const call=(route,body)=>page.evaluate(async({route,body})=>{const r=await fetch(route,{method:'POST',headers:{'X-Yoisaki-Local':'1','Content-Type':'application/json'},body:JSON.stringify(body)});return r.json()},{route,body});
try{
 await page.goto(base+'/models');await page.getByRole('button',{name:'Войти в Google',exact:true}).click();await page.getByText('test@example.invalid').waitFor();
 assert.equal(bound,null);assert.equal((await app.status()).state,'OFFLINE');
 await page.getByRole('button',{name:'Выбрать папку',exact:true}).click();await page.getByRole('button',{name:'Выбрать',exact:true}).click();await page.getByText('Папка сохранена на телефоне.',{exact:true}).waitFor();
 assert(await page.getByRole('button',{name:'Использовать на подключённом GPU'}).isDisabled());await page.reload();await page.getByText('My models',{exact:true}).waitFor();
 for(const width of [360,390,430]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Drive overflow '+width)}
 await fs.mkdir('/tmp/yoisaki-ui',{recursive:true});await page.screenshot({path:'/tmp/yoisaki-ui/drive-offline.png',fullPage:true});
 await page.goto(base+'/engine');await page.getByRole('button',{name:'CloudCompute',exact:true}).click();await page.getByLabel('API-ключ CloudCompute',{exact:true}).fill('cc-browser_test_key_123');await page.getByRole('button',{name:'Проверить и сохранить',exact:true}).click();await page.getByText('YOISAKI GPU · #17',{exact:true}).waitFor();
 apiFail=true;await page.getByRole('button',{name:'Обновить инстансы',exact:true}).click();await page.getByText(/CloudCompute HTTP 429/).waitFor();await page.getByText(/Список не подтверждён/).waitFor();apiFail=false;
 await page.getByRole('button',{name:'Обновить инстансы',exact:true}).click();await page.getByText(/Статусы получены от CloudCompute/).waitFor();
 for(const width of [360,390,430]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'CC overflow '+width)}
 await page.screenshot({path:'/tmp/yoisaki-ui/cloudcompute.png',fullPage:true});
 await call('/api/gpu/connect',{provider:'cloudcompute',url:'https://gpu.example.com/#token='+'a'.repeat(64)});await page.goto(base+'/models');await page.getByRole('button',{name:'Использовать на подключённом GPU'}).click();await page.getByText(/Доступ передан GPU/).waitFor();assert.equal(bound.root_folder_id,'chosen-models');assert.equal(JSON.parse(bound.token).refresh_token,'test-private-refresh');
 const storage=await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}));const html=await page.content();for(const secret of ['test-private-refresh','test-private-access','cc-browser_test_key_123','GOCSPX-test_secret'])assert(!storage.includes(secret)&&!html.includes(secret),secret);
 assert.deepEqual(errors,[]);console.log('PASS: mobile 360/390/430, browser OAuth callback without GPU, choose folder, reload persistence, explicit GPU binding, CC key/password, discovery, stale/error recovery, no credentials in browser storage/DOM. Providers mocked; live Google and live GPU NOT verified.');
}catch(e){console.error('Page:',page.url(),await page.locator('body').innerText());throw e}finally{await browser.close();await app.close();await fs.rm(dir,{recursive:true,force:true})}
