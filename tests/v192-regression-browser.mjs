// Reproduces the four Android screenshots in Chromium mobile emulation against the real local server.
// Engine replies are SYNTHETIC; this is not a test on a real Android phone or a Tesla T4.
//   node tests/v192-regression-browser.mjs            (current tree, needs `npm run build`)
//   TEST_ROOT=/path/to/other/build node tests/v192-regression-browser.mjs
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(process.env.TEST_ROOT||'.');
const {createLocalApp}=await import(pathToFileURL(path.join(root,'server/app.mjs')));
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'v192-regression-browser-'));
const OLD='https://old-session.trycloudflare.com',NEW='https://new-session.trycloudflare.com';
const LOST=['add55d35','ee0ac494','e82d53d3','61c9fe82'].map((p,i)=>p+'-0000-4000-8000-00000000000'+i);
const sent=[],gpuCalls=[],errors=[];
const png=await fs.readFile(path.resolve('tests/fixtures/control-reference.png'));
const model={id:'b'.repeat(32),name:'TEST Checkpoint',kind:'checkpoint',architecture:'SDXL',compatible:true,size_bytes:1};
const app=await createLocalApp({dataDir:dir,distDir:path.join(root,'dist'),autoResume:false,upstream:async(c,p,o={})=>{
 gpuCalls.push({origin:c.origin,path:p,method:o.method||'GET'});
 if(p==='/health')return {engine:'YOISAKI_ENGINE',engine_version:'1.8.1',api_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true,result_ack:true},state:'READY',gpu_name:'SYNTHETIC',vram_total_mb:16000,vram_available_mb:14000};
 if(p==='/models')return {models:[model]};
 if(p==='/controlnet/preprocess'){const r=JSON.parse(o.body);return {image:r.image,type:r.type,width:r.width,height:r.height,...(r.preprocessor?{preprocessor:r.preprocessor}:{})}}
 if(p==='/generate'){const r=JSON.parse(o.body);sent.push(r);return {id:r.client_request_id,status:'QUEUED'}}
 if(p.startsWith('/jobs/')&&o.method!=='DELETE'){const id=p.split('/').pop();const r=sent.find(x=>x.client_request_id===id);if(!r)throw Object.assign(Error('unknown job'),{code:'JOB_NOT_FOUND',status:404});return {id,status:'RUNNING',progress:{step:1,total_steps:30,percent:3,stage:'GENERATING'}}}
 throw Error('Unexpected GPU call '+(o.method||'GET')+' '+p);
}});
const lost=id=>({id,status:'CONNECTION_LOST',created:Date.now()-3600e3,updated:Date.now()-3600e3,origin:OLD,provider:'colab',connection_error:'Ожидается подтверждение GPU',progress:{step:15,total_steps:35,percent:43,stage:'GENERATING',elapsed_seconds:55},request:{prompt:'old',width:512,height:512}});
await app.store.change(d=>{d.history=LOST.map(lost);d.settings={version:2,state:{settings:{checkpoint:model.id,prompt:'exact prompt',width:512,height:512}}}});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+app.server.address().port;
const browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.PW_CHROMIUM?{executablePath:process.env.PW_CHROMIUM}:{})});
const page=await browser.newPage({viewport:{width:412,height:915},isMobile:true,hasTouch:true,locale:'ru-RU'});
page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
const api=(p,method='GET',body)=>page.evaluate(async({p,method,body})=>{const r=await fetch(p,{method,headers:{'X-Yoisaki-Local':'1','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return r.json()},{p,method,body});
let failed=0;const results=[];
async function check(name,fn){try{await fn();results.push('PASS '+name)}catch(e){failed++;results.push('FAIL '+name+': '+String(e.message).split('\n')[0])}console.log(results.at(-1))}
async function eventually(fn,what='condition'){for(let i=0;i<60;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100))}throw Error('timeout: '+what)}
const conflict='Одновременная работа Regional Control и ControlNet пока не поддерживается.';
const panel=page.locator('details').filter({has:page.locator('summary',{hasText:'REGIONAL CONTROL'})}).first();
const mode=page.getByLabel('Regional mode',{exact:true});
const tabNames=async()=>panel.getByRole('button',{name:/^Region [A-Z]$/}).allInnerTexts();
const cn=page.getByRole('switch',{name:'Включить ControlNet'});
const open=async()=>{await panel.evaluate(el=>el.open=true);await page.locator('summary.h-spark').filter({hasText:'ControlNet'}).evaluate(el=>el.parentElement.open=true)};
const submit=async()=>{const n=sent.length;await page.getByTestId('generate-button').click();await eventually(()=>sent.length===n+1,'request sent');return sent[n]};
try{
 await page.goto(base+'/generate');await page.locator('.app-header').waitFor();
 await api('/api/gpu/connect','POST',{url:NEW+'/#token='+'a'.repeat(64)});
 await page.reload();await page.locator('.gpu-chip[data-tone=ok]').waitFor();await open();

 // Screenshot 4: GPU READY, but an old job was shown as the current generation ("СВЯЗЬ ПОТЕРЯНА 15/35").
 await check('READY GPU: old-session job is not presented as the current generation',async()=>{
  const hero=page.getByTestId('generate-button');await page.waitForTimeout(3500);
  assert.equal(await hero.getAttribute('data-state'),'idle');const text=await hero.innerText();assert(!/15\/35|СВЯЗЬ ПОТЕРЯНА/i.test(text),text);
 });
 // Screenshot 1: "2 ПЕРСОНАЖА" showed Region A, B, C.
 await check('"2 ПЕРСОНАЖА" shows exactly Region A, Region B',async()=>{await mode.selectOption({label:'2 ПЕРСОНАЖА'});assert.deepEqual(await tabNames(),['Region A','Region B'])});
 await check('2 characters → request carries 2 regions',async()=>{const r=await submit();assert.equal(r.regions.length,2)});
 await check('"3 ПЕРСОНАЖА" shows three regions; back to two shows two',async()=>{await mode.selectOption({label:'3 ПЕРСОНАЖА'});assert.deepEqual(await tabNames(),['Region A','Region B','Region C']);await page.getByLabel('Промпт области',{exact:true}).fill('');await panel.getByRole('button',{name:'Region C',exact:true}).click();await page.getByLabel('Промпт области',{exact:true}).fill('third character');await mode.selectOption({label:'2 ПЕРСОНАЖА'});assert.deepEqual(await tabNames(),['Region A','Region B'])});
 await check('selected tab is valid after the count shrinks (no empty editor)',async()=>{assert.equal(await page.getByLabel('Region name',{exact:true}).count()+await page.getByLabel('Название области',{exact:true}).count()>0,true)});
 await check('CUSTOM keeps the real configured count',async()=>{await mode.selectOption({label:'СВОИ ОБЛАСТИ'});assert.deepEqual(await tabNames(),['Region A','Region B']);await mode.selectOption({label:'2 ПЕРСОНАЖА'})});
 // Screenshot 2: "ВЫКЛ" + ControlNet still showed the conflict warning.
 await mode.selectOption({label:'ВЫКЛ'});
 await check('OFF hides region tabs and the regional hint',async()=>{assert.deepEqual(await tabNames(),[])});
 await cn.check();await page.locator('details').filter({has:page.locator('summary.h-spark').filter({hasText:'ControlNet'})}).locator('input[type=file]').setInputFiles({name:'control.png',mimeType:'image/png',buffer:png});
 for(const type of ['Depth','Canny','OpenPose'])await check('Regional OFF + ControlNet '+type+': no warning, regions [] in request JSON',async()=>{
  await page.getByLabel('Тип управления',{exact:true}).selectOption(type);await page.getByRole('button',{name:'Подготовить карту',exact:true}).click();await page.getByAltText('Карта '+type,{exact:true}).waitFor();
  assert.equal(await page.getByText(conflict).count(),0);const r=await submit();assert.deepEqual(r.regions,[]);assert.equal(r.controlnet_config.enabled,true);assert.equal(r.controlnet_config.type,type);assert.equal(r.prompt,'exact prompt');
 });
 await check('Regional ON + ControlNet ON is still blocked with the warning',async()=>{await mode.selectOption({label:'2 ПЕРСОНАЖА'});await page.getByText(conflict).first().waitFor();const n=sent.length;await page.getByTestId('generate-button').click();await page.waitForTimeout(400);assert.equal(sent.length,n);await mode.selectOption({label:'ВЫКЛ'});await page.getByText(conflict).first().waitFor({state:'hidden'})});
 await check('reload: OFF persists, no false warning, saved regions intact (C kept)',async()=>{await page.reload();await open();assert.equal(await mode.inputValue(),'OFF');assert.equal(await page.getByText(conflict).count(),0);await mode.selectOption({label:'3 ПЕРСОНАЖА'});await panel.getByRole('button',{name:'Region C',exact:true}).click();assert.equal(await page.getByLabel('Промпт области',{exact:true}).inputValue(),'third character');await mode.selectOption({label:'ВЫКЛ'})});
 await check('legacy saved "2 ПЕРСОНАЖА" with 3 stored regions (old build) shows 2 after reload',async()=>{const saved=(await api('/api/settings')).value;saved.state.settings.regional={...saved.state.settings.regional,mode:'2 ПЕРСОНАЖА'};await api('/api/settings','PUT',{value:saved});await page.reload();await open();assert.deepEqual(await tabNames(),['Region A','Region B']);await mode.selectOption({label:'ВЫКЛ'});await page.waitForTimeout(500)});

 // Screenshot 3: four "Связь потеряна" records that "Проверить и удалить" could not remove.
 const card=id=>page.locator('.card').filter({hasText:id.slice(0,8)}).filter({has:page.getByRole('button')}).first();
 await check('"Проверить и удалить" removes an old-session record after confirmation, without GPU',async()=>{
  await card(LOST[0]).locator('button',{hasText:'Проверить и удалить'}).click();await eventually(()=>!app.store.data.history.some(j=>j.id===LOST[0]),'record removed');
 });
 await check('remaining stale records are removed together; counters update',async()=>{
  await page.getByRole('button',{name:/Убрать все потерянные/}).click();await eventually(()=>app.store.data.history.length===sent.length,'stale removed');
  for(const id of LOST.slice(1))assert.equal(await page.getByText(id.slice(0,8)).count(),0);
 });
 await check('removed records do not reappear after reload and repeated polling',async()=>{await page.reload();await page.waitForTimeout(3500);await app.pollJobs();for(const id of LOST)assert.equal(await page.getByText(id.slice(0,8)).count(),0);assert(!app.store.data.history.some(j=>LOST.includes(j.id)))});
 await check('no GPU cancel / status call was sent for old jobs; no automatic re-generation',async()=>{assert.deepEqual(gpuCalls.filter(c=>c.method==='DELETE'||LOST.some(id=>c.path.includes(id))),[]);assert.equal(sent.length,4)});
 await check('no browser runtime errors',async()=>assert.deepEqual(errors,[]));
}finally{await browser.close();await app.close();await fs.rm(dir,{recursive:true,force:true})}
console.log(`Failures: ${failed}/${results.length}; root=${root}; SYNTHETIC engine, Chromium mobile emulation (not Android/T4).`);
process.exitCode=failed?1:0;
