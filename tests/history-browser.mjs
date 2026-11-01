import {chromium} from '@playwright/test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';import {createLocalApp} from '../server/app.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'history-mobile-'));
const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),upstream:async(c,p)=>p==='/health'?{engine:'YOISAKI_ENGINE',engine_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true},state:'READY',gpu_name:'TEST',vram_total_mb:100,vram_available_mb:100}:p==='/models'?{models:[]}:{id:p.split('/').pop(),status:'QUEUED'}});
const rows=['COMPLETED','FAILED','INTERRUPTED','CANCELLED','RUNNING','QUEUED','CONNECTION_LOST'].map(status=>({id:randomUUID(),status,created:Date.now(),updated:Date.now(),request:{prompt:'keep'},origin:'https://test.trycloudflare.com'}));
await app.store.change(d=>{d.history=rows;d.tags.keep={trigger_words:['amber_character']}});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1cAAAAASUVORK5CYII=','base64');
const gallery={id:rows[0].id+'_0',favorite:true,prompt:'saved prompt',parameters:{regional:{mask:'keep-mask'}},type:'image/png'};await app.store.saveImage(gallery,png);
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/generate');
 await page.getByText('История генераций (4)',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Удалить запись '+rows[0].id,exact:true}).isVisible(),false);
 assert(await page.getByText('RUNNING · '+rows[4].id.slice(0,8),{exact:true}).isVisible());assert(await page.getByText('QUEUED · '+rows[5].id.slice(0,8),{exact:true}).isVisible());
 await page.getByText('История генераций (4)',{exact:true}).click();const remove=page.getByRole('button',{name:'Удалить запись '+rows[0].id,exact:true});const box=await remove.boundingBox();assert(box.width>=44&&box.height>=44);await remove.click();await page.getByText('История генераций (3)',{exact:true}).waitFor();assert(!app.store.data.history.some(j=>j.id===rows[0].id));
 await page.reload();await page.getByText('История генераций (3)',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Удалить запись '+rows[0].id,exact:true}).count(),0);
 await page.getByText('Очистить ▾',{exact:true}).click();page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'Удалить все завершённые',exact:true}).click();assert.equal(app.store.data.history.length,6);
 page.once('dialog',async d=>{assert(d.message().includes('3'));await d.accept()});await page.getByRole('button',{name:'Удалить все завершённые',exact:true}).click();await page.getByText('История генераций (0)',{exact:true}).waitFor();assert.equal(app.store.data.history.length,3);
 assert.deepEqual(app.store.data.gallery,[gallery]);assert.deepEqual(await fs.readFile(path.join(dir,'images',gallery.id)),png);assert.deepEqual(app.store.data.tags.keep.trigger_words,['amber_character']);
 await page.reload();await page.getByText('История генераций (0)',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.goto(base+'/engine');await page.getByLabel('URL туннеля Colab').fill('https://test.trycloudflare.com/#token='+'a'.repeat(64));await page.getByRole('button',{name:'Подключиться',exact:true}).click();await page.getByText('YOISAKI ENGINE v1.7.0',{exact:true}).waitFor();assert(await page.getByText('YOISAKI AI STUDIO v1.7.0 · COMPATIBLE',{exact:true}).isVisible());assert.deepEqual(errors,[]);
 console.log('PASS mobile 390x844: collapsed history, visible active jobs, 44px deletion, reload persistence, confirmation dismiss/accept, bulk deletion, gallery+favorites+triggers intact, separate compatible versions.');
}finally{await browser.close();await app.close();await fs.rm(dir,{recursive:true,force:true})}
