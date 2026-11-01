import {chromium} from '@playwright/test';import fs from 'node:fs/promises';
await fs.mkdir('../screenshots',{recursive:true});const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const results=[];
for(const width of [360,390,430]){
 const context=await browser.newContext({viewport:{width,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const route of ['generate','edit','models','engine','gallery']){
  await page.goto('http://127.0.0.1:3000/'+route);await page.locator('.bottomnav').waitFor();await page.locator('.page h1').waitFor();await page.waitForTimeout(150);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);if(overflow)throw Error('Overflow '+width+' '+route);
  await page.screenshot({path:`../screenshots/${width}-${route}.png`,fullPage:true});results.push({width,route,overflow,errors:[...errors]});
 }
 await page.getByRole('button',{name:'Настройки',exact:true}).click().catch(()=>page.getByRole('button',{name:'Settings',exact:true}).click());await page.getByRole('dialog').waitFor();await page.screenshot({path:`../screenshots/${width}-settings.png`});results.push({width,route:'settings',errors:[...errors]});
 await context.close();
}
await browser.close();await fs.writeFile('../mobile-results.json',JSON.stringify(results,null,2));if(results.some(x=>x.errors.length))throw Error('Browser errors recorded');console.log('PASS: mobile routes + settings at 360/390/430');
