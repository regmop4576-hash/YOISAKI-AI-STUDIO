// Chromium mobile emulation + real local server; all engine replies below are synthetic.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(process.env.TEST_ROOT||'.');
const {createLocalApp}=await import(pathToFileURL(path.join(root,'server/app.mjs')));
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'v192-browser-'));
const sent=[],jobs=new Map(),errors=[];
let outage=false;
const png=await fs.readFile('tests/fixtures/control-reference.png');
const model={id:'b'.repeat(32),name:'TEST Checkpoint',kind:'checkpoint',architecture:'SDXL',compatible:true,size_bytes:1};
const app=await createLocalApp({dataDir:dir,distDir:path.join(root,'dist'),autoResume:false,upstream:async(c,p,o={})=>{
 if(outage)throw Object.assign(Error('Synthetic Colab disconnected'),{code:'TUNNEL_OFFLINE',status:502});
 if(p==='/health')return {engine:'YOISAKI_ENGINE',engine_version:'1.8.1',api_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true,result_ack:true},state:'READY',gpu_name:'SYNTHETIC',vram_total_mb:16000,vram_available_mb:14000};
 if(p==='/models')return {models:[model]};
 if(p==='/controlnet/preprocess'){const r=JSON.parse(o.body);return {image:r.image,type:r.type,width:r.width,height:r.height,...(r.preprocessor?{preprocessor:r.preprocessor}:{})}}
 if(p==='/generate'){const r=JSON.parse(o.body);sent.push(r);jobs.set(r.client_request_id,{id:r.client_request_id,status:'RUNNING',progress:{step:33,total_steps:35,percent:94,stage:'GENERATING'}});return {id:r.client_request_id,status:'QUEUED'}}
 if(p.endsWith('/ack'))return {ok:true};
 if(p.startsWith('/results/'))return png;
 if(p.startsWith('/jobs/'))return jobs.get(p.split('/').pop());
 throw Error('Unexpected '+p);
}});
await app.store.change(d=>{d.settings={version:2,state:{settings:{checkpoint:model.id,prompt:'  prompt stays exact\n',width:512,height:512}}}});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+app.server.address().port;
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
const api=(p,method='GET',body)=>page.evaluate(async({p,method,body})=>{const r=await fetch(p,{method,headers:{'X-Yoisaki-Local':'1','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return r.json()},{p,method,body});
let failed=0;
async function check(name,fn){try{await fn();console.log('PASS '+name)}catch(e){failed++;console.log('FAIL '+name+': '+e.message)}}
const conflict='Одновременная работа Regional Control и ControlNet пока не поддерживается.';
const region=page.getByLabel('Regional mode',{exact:true});
const cn=page.getByRole('switch',{name:'Включить ControlNet'});
const openPanels=async()=>{await page.locator('summary').filter({hasText:'REGIONAL CONTROL'}).evaluate(el=>el.parentElement.open=true);await page.locator('summary.h-spark').filter({hasText:'ControlNet'}).evaluate(el=>el.parentElement.open=true)};
const submit=async()=>{const n=sent.length;await page.getByTestId('generate-button').click();await page.waitForFunction(n=>document.querySelectorAll('[data-testid=generate-button][data-sending=true]').length===0,n);await assertEventually(()=>sent.length===n+1);return sent[n]};
async function assertEventually(fn){for(let i=0;i<80;i++){if(fn())return;await new Promise(r=>setTimeout(r,100))}assert(fn())}
try{
 let release;const gate=new Promise(r=>{release=r});
 await page.route('**/api/gpu/status*',async route=>{await gate;await route.continue().catch(()=>{})});
 await page.goto(base+'/generate');
 await check('first paint does not wait for a delayed GPU health request',async()=>{await page.locator('.app-header').waitFor({timeout:2000})});
 release();await page.unroute('**/api/gpu/status*');await page.locator('.app-header').waitFor();
 await api('/api/gpu/connect','POST',{url:'https://test.trycloudflare.com/#token='+'a'.repeat(64)});
 await page.reload();await page.locator('.gpu-chip[data-tone=ok]').waitFor();await openPanels();
 await check('Regional OFF + ControlNet OFF sends regions [] and exact prompt',async()=>{const r=await submit();assert.deepEqual(r.regions,[]);assert.equal(r.prompt,'  prompt stays exact\n');assert.equal(r.controlnet_config.enabled,false)});
 await region.selectOption({label:'2 ПЕРСОНАЖА'});await page.getByLabel('Regional trigger',{exact:true}).fill('amber_character');await page.getByLabel('Промпт области',{exact:true}).fill('white sweater, exact regional prompt');
 await check('Regional ON + ControlNet OFF sends both masks and regional prompt',async()=>{const r=await submit();assert.equal(r.regions.length,2);assert.equal(r.regions[0].trigger,'amber_character');assert(r.regions.every(x=>x.mask.startsWith('data:image/png;base64,')))});
 await cn.check();
 await check('real simultaneous enablement warns and prevents submission',async()=>{const n=sent.length;await page.getByTestId('generate-button').click();await page.getByText(conflict,{exact:true}).waitFor();assert.equal(sent.length,n)});
 await region.selectOption({label:'ВЫКЛ'});
 await check('disabling Regional immediately clears the obsolete compatibility warning',async()=>{await page.getByText(conflict,{exact:true}).waitFor({state:'hidden'})});
 await region.selectOption({label:'2 ПЕРСОНАЖА'});
 await check('OFF → ON preserves region IDs, prompts, trigger and mask',async()=>{assert.equal(await page.getByLabel('Regional trigger',{exact:true}).inputValue(),'amber_character');assert.equal(await page.getByLabel('Промпт области',{exact:true}).inputValue(),'white sweater, exact regional prompt');const saved=app.store.data.settings.state.settings.regional;assert.equal(saved.regions.length,2);assert.deepEqual(saved.regions[0].rect,[0,0,.5,1])});
 await region.selectOption({label:'ВЫКЛ'});
 await page.locator('details').filter({has:page.locator('summary.h-spark').filter({hasText:'ControlNet'})}).locator('input[type=file]').setInputFiles({name:'control.png',mimeType:'image/png',buffer:png});
 for(const type of ['Depth','Canny','OpenPose'])await check('Regional OFF + '+type+' ON uses ControlNet independently',async()=>{
  await page.getByLabel('Тип управления',{exact:true}).selectOption(type);await page.getByRole('button',{name:'Подготовить карту',exact:true}).click();await page.getByAltText('Карта '+type,{exact:true}).waitFor();
  const r=await submit();assert.deepEqual(r.regions,[]);assert.equal(r.controlnet_config.type,type);assert.equal(r.controlnet_config.enabled,true);assert.equal(r.controlnet_config.strength,.8);assert.equal(r.controlnet_config.start,0);assert.equal(r.controlnet_config.end,1);assert.equal(await page.getByText(conflict,{exact:true}).count(),0);
 });
 await check('reload preserves Regional OFF, regions and ControlNet settings without false warning',async()=>{await page.reload();await openPanels();assert.equal(await region.inputValue(),'OFF');assert(await cn.isChecked());assert.equal(await page.getByLabel('Тип управления',{exact:true}).inputValue(),'OpenPose');await region.selectOption({label:'2 ПЕРСОНАЖА'});assert.equal(await page.getByLabel('Regional trigger',{exact:true}).inputValue(),'amber_character');await region.selectOption({label:'ВЫКЛ'});assert.equal(await page.getByText(conflict,{exact:true}).count(),0)});
 await check('long Cyrillic prompt keeps focus and survives navigation / reload unchanged',async()=>{const text='  Ёоисаки, белый шум\n'+'длинный промпт, '.repeat(200);const field=page.locator('textarea[data-prompt=positive]');await field.fill(text);await field.focus();await page.waitForTimeout(3200);assert(await field.evaluate(el=>el===document.activeElement));await assertEventually(()=>app.store.data.settings.state.settings.prompt===text);await page.locator('.bottomnav').getByRole('link',{name:'Галерея'}).click();await page.locator('.bottomnav').getByRole('link',{name:'Генерация'}).click();assert.equal(await field.inputValue(),text);await page.reload();assert.equal(await field.inputValue(),text)});
 await check('outage invalidates BUSY and shows last confirmed progress; local remove sends no cancellation',async()=>{await app.pollJobs();outage=true;await app.pollJobs();await page.locator('.gpu-chip[aria-label*="Связь потеряна"]').waitFor();await page.getByRole('button',{name:'Убрать локально',exact:true}).first().waitFor();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Убрать локально',exact:true}).first().click();await assertEventually(()=>app.store.data.history.length===sent.length-1);assert.equal(jobs.size,sent.length)});
 await check('recovery completes remaining jobs and saves gallery exactly once',async()=>{outage=false;for(const j of jobs.values())Object.assign(j,{status:'COMPLETED',result:{image_keys:['0'],seed:123}});await app.pollJobs();await app.pollJobs();await assertEventually(()=>app.store.data.gallery.length===sent.length-1);await page.reload();await page.locator('.gpu-chip[data-tone=ok]').waitFor();assert.equal(app.store.data.history.filter(j=>j.status==='COMPLETED').length,sent.length-1)});
 await check('old saved ВЫКЛ mode is migrated on reload, preserving region data',async()=>{const saved=(await api('/api/settings')).value;saved.state.settings.regional.mode='ВЫКЛ';await api('/api/settings','PUT',{value:saved});await page.reload();await openPanels();assert.equal(await region.inputValue(),'OFF');await region.selectOption({label:'2 ПЕРСОНАЖА'});assert.equal(await page.getByLabel('Regional trigger',{exact:true}).inputValue(),'amber_character');await region.selectOption({label:'ВЫКЛ'});assert.equal(await page.getByText(conflict,{exact:true}).count(),0)});
 await check('no browser runtime errors',async()=>assert.deepEqual(errors,[]));
}finally{await browser.close();await app.close();await fs.rm(dir,{recursive:true,force:true})}
console.log('Failures: '+failed+'; SYNTHETIC engine, Chromium mobile emulation, not Android/T4.');
process.exitCode=failed?1:0;
