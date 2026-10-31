// v1.8.1 SMART FACE FIX: real mobile-sized Chromium + real local server. The GPU upstream is SYNTHETIC:
// /facefix/detect answers fixed boxes chosen by source width; no detector or SDXL runs here.
import {chromium} from '@playwright/test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import zlib from 'node:zlib';import {createLocalApp} from '../server/app.mjs';
const mid='b'.repeat(32),lid='c'.repeat(32),token='e'.repeat(64),sent=[],detects=[],status={};
function encodePNG(w,h,pixel){const raw=Buffer.alloc((w*3+1)*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++)raw.set(pixel(x,y),y*(w*3+1)+1+x*3);
 const chunk=(type,data)=>{const t=Buffer.from(type);const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const crc=Buffer.alloc(4);crc.writeUInt32BE(zlib.crc32(Buffer.concat([t,data])));return Buffer.concat([len,t,data,crc])};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))])}
const one=encodePNG(600,400,x=>x<300?[230,140,60]:[60,40,90]),two=encodePNG(640,400,()=>[120,120,160]),none=encodePNG(500,400,()=>[20,90,40]);
const result=encodePNG(600,400,()=>[200,150,40]);
const face=(id,x,y,w,h,c)=>({id,x,y,width:w,height:h,confidence:c,detector:'anime+human',label:'face',auto_selectable:c>=.6});
const ID1='f'+'1'.repeat(12),ID2='f'+'2'.repeat(12),ID3='f'+'3'.repeat(12),IDW='f'+'9'.repeat(12);
function detection(body){const png=Buffer.from(body.image.split(',')[1],'base64');const w=png.readUInt32BE(16),h=png.readUInt32BE(20);
 const faces=w===600?[face(ID1,250,80,120,130,.97)]:w===640?[face(ID2,60,90,110,120,.95),face(ID3,420,100,100,110,.9)]:[face(IDW,200,150,60,60,.42)];
 const strong=faces.filter(f=>f.auto_selectable);
 return {detector:body.detector,detectors_run:['anime','human'],min_confidence:body.min_confidence,auto_select_confidence:.6,image:{width:w,height:h},faces,selected:strong.length===1?strong[0].id:null,selection_required:strong.length!==1&&faces.length>0,duration_ms:12}}
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'facefix-181-'));
const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),upstream:async(c,p,o={})=>{
 if(p==='/health')return {engine:'YOISAKI_ENGINE',engine_version:'1.8.1',api_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true,inpaint:true,facefix:true,editor_contract:1,auto_facefix:true,face_detect_contract:1,result_ack:true},state:'READY',gpu_name:'TEST ONLY',vram_total_mb:16000,vram_available_mb:15000};
 if(p==='/models')return {models:[{id:mid,name:'TEST',kind:'checkpoint',architecture:'SDXL',compatible:true,size_bytes:1},{id:lid,name:'TEST LoRA',kind:'lora',architecture:'SDXL',compatible:true,size_bytes:1}]};
 if(p==='/facefix/detect'){const x=JSON.parse(o.body);detects.push(x);return detection(x)}
 if(p==='/generate'){const x=JSON.parse(o.body);sent.push(x);status[x.client_request_id]={id:x.client_request_id,status:'COMPLETED',progress:{step:1,total_steps:1,stage:'DONE',percent:100},result:{seed:5,image_keys:['0']}};return {id:x.client_request_id,status:'QUEUED'}}
 if(p.endsWith('/ack'))return {ok:true};if(p.startsWith('/results/'))return result;return status[p.split('/').pop()];
}});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const cdp=await page.context().newCDPSession(page),errors=[];page.on('pageerror',e=>errors.push(e.message));
async function touch(p,q=p){await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[p]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:(p.x+q.x)/2,y:(p.y+q.y)/2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[q]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})}
async function waitSent(n){for(let i=0;i<100&&sent.length<n;i++)await new Promise(r=>setTimeout(r,50));assert.equal(sent.length,n,await page.locator('body').innerText())}
async function stagePoint(sx,sy,w,h){const s=page.getByTestId('facefix-stage');await s.scrollIntoViewIfNeeded();const r=await s.boundingBox();return {x:r.x+sx/w*r.width,y:r.y+sy/h*r.height}}
const upload=async(buffer,name)=>{await page.locator('input[type=file]').first().setInputFiles({name,mimeType:'image/png',buffer});await page.getByTestId('facefix-stage').waitFor()};
const fixButton=()=>page.locator('button.facefix-go');
const L=n=>({Steps:/^(Steps|Шаги)$/,Scheduler:/^(Scheduler|Планировщик)$/,CFG:/^(CFG|Шкала CFG)$/}[n]||n);
const noOverflow=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth),0);
try{
 await page.goto('http://127.0.0.1:'+app.server.address().port+'/engine');await page.getByLabel('URL туннеля Colab').fill('https://test.trycloudflare.com/#token='+token);await page.getByRole('button',{name:'Подключиться',exact:true}).click();await page.getByText('GPU: TEST ONLY',{exact:true}).waitFor();
 await page.locator('.bottomnav a[href="/generate"]').click();await page.locator('select[aria-label="Checkpoint"]').selectOption(mid);await page.getByLabel(/^(Positive Prompt|Позитивный промпт)$/).fill('  amber fox, orange eyes  ');await page.getByLabel(/^(Negative Prompt|Негативный промпт)$/).fill('blur');await page.locator('select[aria-label="Add LoRA"],select[aria-label="Добавить LoRA"]').selectOption(lid);
 const studio=async()=>{await new Promise(r=>setTimeout(r,400));const v=app.store.data.settings||{};const x=v.state?.settings||v.settings||v;assert(x.checkpoint===mid,'settings persisted: '+JSON.stringify(v).slice(0,200));const {prompt,negative,checkpoint,vae,loras,width,height,steps,cfg,sampler,scheduler,denoise,batch}=x;return JSON.stringify({prompt,negative,checkpoint,vae,loras,width,height,steps,cfg,sampler,scheduler,denoise,batch})};const settingsBefore=await studio();
 await page.locator('.bottomnav a[href="/edit"]').click();await page.getByRole('tab',{name:'FACE FIX',exact:true}).click();
 // Default screen: advanced parameters collapsed.
 for(const hidden of ['Steps','CFG','Sampler','Scheduler','Рабочая ширина','Детектор'])assert.equal(await page.getByLabel(L(hidden),{exact:true}).count(),0,hidden+' must be hidden by default');
 // A. Exactly one confident face: auto-selected, no rectangle needed.
 await upload(one,'one.png');await page.getByText('Лицо найдено и выбрано автоматически.').waitFor();assert.equal(detects.length,1);assert.equal(detects[0].detector,'auto');
 assert.equal(await page.locator('.facefix-face.selected').count(),1);
 const go=await fixButton().boundingBox();assert(go.height>=44&&go.width>=200,'primary action is a large tap target');
 await fixButton().click();await waitSent(1);let req=sent[0];
 assert.equal(req.mode,'facefix');assert.deepEqual(req.face_detection,{detector:'auto',min_confidence:.35,select:[ID1]});assert(!req.face_region);
 assert.deepEqual(req.face_options,{mask_shape:'ellipse',mask_expand:.08,work_fit:'aspect'});assert.equal(req.width,1024);assert.equal(req.height,1024);assert.equal(req.steps,25);assert.equal(req.cfg_scale,5.5);assert.equal(req.denoising_strength,.3);assert.equal(req.mask_padding,.5);assert.equal(req.mask_blur,10);
 assert.equal(req.prompt,'  amber fox, orange eyes  ');assert.equal(req.negative_prompt,'blur');assert.deepEqual(req.lora_adapters,[{id:lid,weight:.8}]);assert.equal(req.checkpoint_id,mid);assert.equal(req.batch_size,1);assert.deepEqual(req.controlnet_config,{enabled:false});
 assert.equal(req.init_image,detects[0].image,'detection and repair use the exact same source bytes');
 await page.getByRole('link',{name:'Сохранить результат'}).waitFor({timeout:15000});await page.getByAltText('Результат').waitFor();
 await page.locator('input[aria-label="До / После"]').fill('20');assert.match(await page.getByAltText('Результат').getAttribute('style'),/inset\(0(px)? 0(px)? 0(px)? 20%\)/);
 const download=page.waitForEvent('download');await page.getByRole('link',{name:'Сохранить результат'}).click();assert.deepEqual(await fs.readFile(await (await download).path()),result);
 assert(app.store.data.gallery.some(g=>g.job_id===req.client_request_id));const hist=app.store.data.history.find(j=>j.id===req.client_request_id);assert(hist&&!('init_image' in hist.request)&&hist.request.face_detection.select[0]===ID1);
 await noOverflow();await page.screenshot({path:'validation/facefix-auto-390.png',fullPage:true});
 // B. Two faces: nothing silently selected; tap selects one; "fix all" sends both, sequentially processed by the engine.
 await page.getByRole('button',{name:'Оставить оригинал / попробовать снова'}).click();await upload(two,'two.png');await page.getByText(/Найдено лиц: 2/).waitFor();
 assert.equal(await page.locator('.facefix-face.selected').count(),0);assert(await fixButton().isDisabled(),'no face chosen yet');
 const hit=page.getByRole('button',{name:/^Лицо 2,/});const hb=await hit.boundingBox();assert(hb.width>=44&&hb.height>=44,'face tap target ≥ 44 px');
 const scroll=await page.evaluate(()=>scrollY);await touch({x:hb.x+hb.width/2,y:hb.y+hb.height/2});assert.equal(await page.evaluate(()=>scrollY),scroll);
 await page.locator('.facefix-face.selected').waitFor();assert.equal(await hit.getAttribute('aria-pressed'),'true');
 await fixButton().click();await waitSent(2);assert.deepEqual(sent[1].face_detection.select,[ID3]);
 await page.getByRole('button',{name:'Оставить оригинал / попробовать снова'}).click();
 await page.getByLabel(/Исправить все найденные лица \(2\)/).check();assert.equal(await page.locator('.facefix-face.selected').count(),2);assert.match(await fixButton().innerText(),/Исправить лица \(2\)/);
 await fixButton().click();await waitSent(3);assert.deepEqual(sent[2].face_detection.select.sort(),[ID2,ID3].sort());
 await page.screenshot({path:'validation/facefix-two-faces-390.png',fullPage:true});
 // C. No confident face: clear message, nothing sent automatically, manual rectangle fallback without page scroll.
 await page.getByRole('button',{name:'Оставить оригинал / попробовать снова'}).click();await upload(none,'none.png');
 await page.getByText(/низкой уверенностью/).waitFor();assert.equal(sent.length,3,'no automatic full-image repair');
 // Uncertain candidate: hidden by default, never auto-selected; can be revealed and chosen explicitly.
 await page.getByRole('button',{name:/Показать неуверенные \(1\)/}).click();await page.locator('.facefix-face.uncertain').waitFor();assert.equal(await page.locator('.facefix-face.selected').count(),0);
 await page.getByRole('button',{name:'Скрыть неуверенные'}).click();await page.getByText(/Ручное выделение/).waitFor();
 const a=await stagePoint(150,100,500,400),b=await stagePoint(330,300,500,400);const before=await page.evaluate(()=>scrollY);await touch(a,b);assert.equal(await page.evaluate(()=>scrollY),before,'drawing must not scroll the page');
 await fixButton().click();await waitSent(4);req=sent[3];assert(!req.face_detection);assert(req.face_region.x>140&&req.face_region.x<160&&req.face_region.width>170&&req.face_region.width<190,JSON.stringify(req.face_region));assert.equal(req.face_options.work_fit,'aspect');
 // D. Advanced settings stay available and change only the Face Fix profile.
 await page.getByText('Расширенные настройки',{exact:true}).click();for(const shown of ['Steps','CFG','Sampler','Scheduler','Рабочая ширина','Детектор','Форма маски'])await page.getByLabel(L(shown),{exact:true}).first().waitFor();
 await page.getByLabel('Детектор',{exact:true}).selectOption('anime');await page.getByRole('button',{name:'Найти лица заново'}).click();for(let i=0;i<50&&detects.at(-1).detector!=='anime';i++)await new Promise(r=>setTimeout(r,50));assert.equal(detects.at(-1).detector,'anime');
 assert.equal(await studio(),settingsBefore,'Generate settings untouched by the Face Fix profile');
 await noOverflow();await page.setViewportSize({width:360,height:780});await noOverflow();await page.screenshot({path:'validation/facefix-advanced-360.png',fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('PASS mobile 390/360 touch: one face auto-selected and fixed without a rectangle; two faces require a tap (44px targets, no scroll) and "fix all" sends both ids; no-face shows message and manual fallback without page scroll; advanced collapsed by default and functional; prompts/LoRA/checkpoint preserved; same source bytes for detect and repair; result compare/save/gallery; no horizontal overflow. GPU upstream SYNTHETIC.');
}catch(e){await page.screenshot({path:'validation/facefix-browser-failure.png',fullPage:true});await fs.writeFile('validation/facefix-browser-failure.txt',await page.locator('body').innerText());throw e}finally{await browser.close();await app.close();await fs.rm(dir,{recursive:true,force:true})}
