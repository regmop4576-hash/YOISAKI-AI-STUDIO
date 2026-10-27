// v1.7.0 Img2Img: real mobile-sized browser + local server. GPU transport is explicitly synthetic (NOT T4 inference).
import {chromium} from '@playwright/test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import zlib from 'node:zlib';import {createLocalApp} from '../server/app.mjs';
const mid='b'.repeat(32),lid='c'.repeat(32),token='e'.repeat(64),sent=[],status={},acks=[];
function encodePNG(w,h,pixel){const raw=Buffer.alloc((w*3+1)*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++)raw.set(pixel(x,y),y*(w*3+1)+1+x*3);
 const chunk=(type,data)=>{const t=Buffer.from(type);const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const crc=Buffer.alloc(4);crc.writeUInt32BE(zlib.crc32(Buffer.concat([t,data])));return Buffer.concat([len,t,data,crc])};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))])}
// Three vertical stripes: red | green | blue (600x400).
const source=encodePNG(600,400,x=>x<200?[255,0,0]:x<400?[0,255,0]:[0,0,255]);
const result=encodePNG(8,8,()=>[200,150,40]);
function decodeDataURL(url){const m=/^data:image\/(png|jpeg);base64,(.+)$/.exec(url);assert(m,'source must be a PNG/JPEG data URL');return {type:m[1],bytes:Buffer.from(m[2],'base64')}}
function pngPixels(bytes){const w=bytes.readUInt32BE(16),h=bytes.readUInt32BE(20);assert.equal(bytes[25],6,'canvas PNG is RGBA');const idat=[];for(let o=8;o<bytes.length;){const len=bytes.readUInt32BE(o),type=bytes.toString('latin1',o+4,o+8);if(type==='IDAT')idat.push(bytes.subarray(o+8,o+8+len));o+=12+len}
 const raw=zlib.inflateSync(Buffer.concat(idat)),stride=w*4,out=Buffer.alloc(stride*h);
 for(let y=0;y<h;y++){const f=raw[y*(stride+1)],line=raw.subarray(y*(stride+1)+1,(y+1)*(stride+1));for(let i=0;i<stride;i++){const a=i>=4?out[y*stride+i-4]:0,b=y?out[(y-1)*stride+i]:0,c=i>=4&&y?out[(y-1)*stride+i-4]:0;const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
  out[y*stride+i]=(line[i]+[0,a,b,(a+b)>>1,pa<=pb&&pa<=pc?a:pb<=pc?b:c][f])&255}}
 return {w,h,at:(x,y)=>[...out.subarray(y*stride+x*4,y*stride+x*4+3)]}}
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'img2img-browser-'));
const app=await createLocalApp({dataDir:dir,distDir:path.resolve('dist'),upstream:async(c,p,o={})=>{
 if(p==='/health')return {engine:'YOISAKI_ENGINE',engine_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true},state:'READY',gpu_name:'TEST ONLY',vram_total_mb:16000,vram_available_mb:15000};
 if(p==='/models')return {models:[{id:mid,name:'TEST',kind:'checkpoint',architecture:'SDXL',compatible:true,size_bytes:1},{id:lid,name:'TEST LoRA',kind:'lora',architecture:'SDXL',compatible:true,size_bytes:1}]};
 if(p==='/generate'){const x=JSON.parse(o.body);sent.push(x);status[x.client_request_id]={id:x.client_request_id,status:'COMPLETED',progress:{step:1,total_steps:1,stage:'DONE',percent:100},result:{seed:5,image_keys:['0']}};return {id:x.client_request_id,status:'QUEUED'}}
 if(p.endsWith('/ack')){acks.push(p);return {ok:true}}
 if(p.startsWith('/results/'))return result;
 return status[p.split('/').pop()]||{id:p.split('/').pop(),status:'QUEUED'};
}});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
const submit=()=>page.getByRole('button',{name:'Создать изображение',exact:true}).click();
const waitSent=async n=>{for(let i=0;i<100&&sent.length<n;i++)await new Promise(r=>setTimeout(r,50));assert.equal(sent.length,n)};
const label=(en,ru)=>page.locator(`input[aria-label="${en}"],input[aria-label="${ru}"]`);
const shots=process.env.YOISAKI_SHOTS;
try{
 await page.goto('http://127.0.0.1:'+app.server.address().port+'/engine');await page.getByLabel('URL туннеля Colab').fill('https://test.trycloudflare.com/#token='+token);await page.getByRole('button',{name:'Подключиться',exact:true}).click();await page.getByText('GPU: TEST ONLY',{exact:true}).waitFor();
 await page.locator('.bottomnav a[href="/generate"]').click();await page.locator('select[aria-label="Checkpoint"]').selectOption(mid);await page.getByLabel(/^(Positive Prompt|Позитивный промпт)$/).fill('amber fox, oil painting');await page.getByLabel(/^(Negative Prompt|Негативный промпт)$/).fill('blur');
 await page.locator('select[aria-label="Add LoRA"],select[aria-label="Добавить LoRA"]').selectOption(lid);
 await page.getByRole('tab',{name:'IMG2IMG',exact:true}).click();
 await submit();await page.getByText('Img2Img: загрузите исходное изображение.',{exact:false}).waitFor();assert.equal(sent.length,0,'no request without a source');
 await page.locator('input[type=file][accept^="image/"]').first().setInputFiles({name:'source.png',mimeType:'image/png',buffer:source});
 await page.locator('img[alt="Image-to-image source"]').waitFor();await page.getByText(/Исходник 600 × 400/).waitFor();
 await page.getByRole('button',{name:'Размер по исходнику',exact:true}).click();
 assert.equal(await label('Width','Ширина').inputValue(),'1256');assert.equal(await label('Height','Высота').inputValue(),'840');
 await label('Denoise strength','Сила изменения').fill('0.35');await page.getByText('Шагов денойза: 10 из 30.',{exact:false}).waitFor();
 if(shots)await page.screenshot({path:path.join(shots,'img2img-generate-390.png'),fullPage:true});
 await submit();await waitSent(1);
 let x=sent[0];assert.equal(x.mode,'img2img');assert.equal(x.kind,'img2img');assert.equal(x.denoising_strength,.35);assert.equal(x.prompt,'amber fox, oil painting');assert.equal(x.negative_prompt,'blur');
 assert.equal(x.width,1256);assert.equal(x.height,840);assert.equal(x.steps,30);assert.deepEqual(x.lora_adapters,[{id:lid,weight:.8}]);assert.equal(x.controlnet_config.enabled,false);
 let img=decodeDataURL(x.init_image);assert.equal(img.type,'png');assert.equal(img.bytes.readUInt32BE(16),1256);assert.equal(img.bytes.readUInt32BE(20),840,'source fitted to the generation size');
 // Result is collected into the gallery by the local server and shown in the preview.
 await page.locator('img[alt="Созданное изображение"]').first().waitFor({timeout:15000});
 const gallery=app.store.data.gallery.filter(g=>g.job_id===x.client_request_id);assert.equal(gallery.length,1);assert.equal(gallery[0].parameters.mode,'img2img');assert.equal(gallery[0].parameters.denoising_strength,.35);assert(!('init_image' in gallery[0].parameters));
 assert(!JSON.stringify(app.store.data).includes(x.init_image.slice(40,400)),'base64 source must not be stored');
 // Square output from the 3:2 source: centre crop (source x 100..500), never stretched.
 // Crop puts the stripe borders at x=256/768; stretching would put them at x=341/683.
 await page.getByRole('button',{name:'1:1',exact:true}).click();await submit();await waitSent(2);
 img=decodeDataURL(sent[1].init_image);const px=pngPixels(img.bytes);assert.equal(px.w,1024);assert.equal(px.h,1024);
 for(const [xx,yy,want] of [[200,512,0],[300,100,1],[512,512,1],[720,900,1],[820,512,2]]){const c=px.at(xx,yy);assert(c[want]>200&&c.every((v,i)=>i===want||v<60),`centre crop expected at ${xx},${yy}: ${c}`)}
 // Denoise too low for the step count: explained, nothing sent.
 await label('Steps','Шаги').fill('10');await label('Denoise strength','Сила изменения').fill('0.05');
 await page.getByText('Img2Img: при таком Denoise не выполняется ни одного шага. Увеличьте Denoise или Steps.',{exact:true}).first().waitFor();await submit();await new Promise(r=>setTimeout(r,200));assert.equal(sent.length,2);
 await label('Denoise strength','Сила изменения').fill('0.5');
 // Text2Img is unchanged: no source fields at all.
 await page.getByRole('tab',{name:'TEXT2IMG',exact:true}).click();await submit();await waitSent(3);
 assert.equal(sent[2].mode,'text2img');assert(!('init_image' in sent[2])&&!('denoising_strength' in sent[2]));
 // Editor IMG2IMG tab: the same real backend path, mode fixed to Img2Img.
 await page.locator('.bottomnav a[href="/edit"]').click();await page.getByRole('tab',{name:'IMG2IMG',exact:true}).click();
 assert.equal(await page.getByRole('tab',{name:'TEXT2IMG',exact:true}).count(),0,'mode is fixed in the editor');
 await submit();await page.getByText('Img2Img: загрузите исходное изображение.',{exact:false}).waitFor();assert.equal(sent.length,3);
 await page.locator('input[type=file][accept^="image/"]').first().setInputFiles({name:'source.png',mimeType:'image/png',buffer:source});await page.locator('img[alt="Image-to-image source"]').waitFor();
 await submit();await waitSent(4);x=sent[3];assert.equal(x.mode,'img2img');assert.equal(x.denoising_strength,.5);assert.equal(decodeDataURL(x.init_image).bytes.readUInt32BE(16),x.width);
 await page.locator('img[alt="Созданное изображение"]').first().waitFor({timeout:15000});
 if(shots)await page.screenshot({path:path.join(shots,'img2img-editor-390.png'),fullPage:true});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);assert(overflow<=0,'no horizontal overflow at 390px');
 for(let i=0;i<20&&acks.length<3;i++){await app.pollJobs();await new Promise(r=>setTimeout(r,50))}
 assert(acks.length>=3,'1.7.0 results are acknowledged');
 assert.deepEqual(errors,[]);console.log('PASS mobile browser 390x844: Img2Img tab, source upload/preview, size from source, Denoise steps, real request (prompt/negative/LoRA/size/steps/denoise), centre-crop source, low-Denoise guard, result in preview + gallery without base64, Text2Img unchanged, Editor IMG2IMG submits; synthetic upstream only.');
}catch(e){await page.screenshot({path:'validation/img2img-failure.png',fullPage:true});await fs.writeFile('validation/img2img-failure.json',JSON.stringify({errors,body:await page.locator('body').innerText()},null,2));throw e}finally{await browser.close();await app.close();await fs.rm(dir,{recursive:true,force:true})}
