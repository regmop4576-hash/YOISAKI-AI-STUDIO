// v1.9.2 hotfix: ORIGIN_DENIED when the site is opened from GitHub, Termux (termux-open-url) or an Android shortcut.
// Top-level GET navigation to an app page is allowed from anywhere; everything else from another site stays denied.
import {test} from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createLocalApp,APP_PAGES,isAppNavigation} from '../server/app.mjs';

async function harness(){
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-nav-'));
 const app=await createLocalApp({dataDir,distDir:path.resolve('dist'),upstream:async()=>{throw Error('no GPU in this test')}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const port=app.server.address().port;const base='http://127.0.0.1:'+port;
 const s=await fetch(base+'/api/session',{headers:{'X-Yoisaki-Local':'1'}});const cookie=s.headers.get('set-cookie').split(';')[0];
 const raw=(route,headers={},method='GET',body)=>new Promise((resolve,reject)=>{const r=http.request(base+route,{method,headers},res=>{let t='';res.setEncoding('utf8');res.on('data',d=>t+=d);res.on('end',()=>resolve({status:res.statusCode,type:res.headers['content-type']||'',body:t}))});r.on('error',reject);if(body)r.write(body);r.end()});
 return {base,port,cookie,raw,close:async()=>{await app.close?.();app.server.close();await fs.rm(dataDir,{recursive:true,force:true})}};
}
const nav=site=>({'Sec-Fetch-Site':site,'Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document','Sec-Fetch-User':'?1'});

test('top-level navigation to every app page is allowed from GitHub, Termux and Android shortcuts',async()=>{
 const h=await harness();try{
  for(const route of APP_PAGES){
   for(const [label,headers] of [
    ['link on github.com (cross-site)',{...nav('cross-site'),Referer:'https://github.com/'}],
    ['termux-open-url / Android intent (cross-site)',nav('cross-site')],
    ['address bar or home-screen shortcut (none)',nav('none')],
    ['link from another local site (same-site)',nav('same-site')],
    ['browser without Fetch Metadata',{}],
   ]){
    const r=await h.raw(route,headers);
    assert.equal(r.status,200,`${route} — ${label}: ${r.body.slice(0,120)}`);
    assert.match(r.type,/^text\/html/,route);assert.match(r.body,/<div id="root"><\/div>/,route);assert.doesNotMatch(r.body,/ORIGIN_DENIED/);
   }
  }
  // The page then loads its assets and API same-origin, as a real browser does.
  assert.equal((await h.raw('/assets/main.js',{'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'no-cors','Sec-Fetch-Dest':'script'})).status,200);
  assert.equal((await h.raw('/api/session',{'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty','X-Yoisaki-Local':'1'})).status,200);
 }finally{await h.close()}
});

test('external sites still cannot call the API, frame pages, post forms or load app files',async()=>{
 const h=await harness();try{
  const denied=async(label,route,headers,method='GET',body)=>{const r=await h.raw(route,headers,method,body);assert.equal(r.status,403,`${label}: ${r.status} ${r.body.slice(0,100)}`);if(method!=='HEAD')assert.match(r.body,/ORIGIN_DENIED/,label)};
  const cors={'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty','X-Yoisaki-Local':'1'};
  await denied('fetch() of /api/session from evil site',route('/api/session'),cors);
  await denied('fetch() with stolen-cookie attempt',route('/api/settings'),{...cors,Cookie:h.cookie});
  await denied('POST to API from evil site',route('/api/gpu/connect'),{...cors,Cookie:h.cookie,'Content-Type':'application/json'},'POST','{"url":"https://a.trycloudflare.com/#token='+'a'.repeat(64)+'"}');
  await denied('Origin header of evil site on API',route('/api/session'),{Origin:'https://evil.example','X-Yoisaki-Local':'1'});
  await denied('top-level navigation to an API route',route('/api/session'),{...nav('cross-site'),'X-Yoisaki-Local':'1'});
  await denied('top-level navigation to the service route',route('/_yoisaki/service'),nav('cross-site'));
  await denied('cross-site form POST navigation to a page',route('/'),nav('cross-site'),'POST','a=1');
  await denied('cross-site HEAD navigation',route('/generate'),nav('cross-site'),'HEAD');
  await denied('page inside an iframe of evil site',route('/generate'),{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'iframe'});
  await denied('page inside <embed>/<object>',route('/generate'),{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'embed'});
  await denied('navigation to a static file',route('/assets/main.js'),nav('cross-site'));
  await denied('navigation to an unknown path',route('/etc/passwd'),nav('cross-site'));
  await denied('script include of app bundle',route('/assets/main.js'),{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'no-cors','Sec-Fetch-Dest':'script'});
  await denied('fetch() of a page (not a navigation)',route('/generate'),{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty'});
  await denied('forged OAuth return with unknown state',route('/?state='+'f'.repeat(64)+'&code=x'),nav('cross-site'));
  await denied('navigation with a code parameter',route('/generate?code=x'),nav('cross-site'));
  // Host check is untouched: a DNS-rebinding page is refused even for a navigation.
  const rebind=await h.raw('/generate',{...nav('cross-site'),Host:'evil.example:'+h.port});assert.equal(rebind.status,403);assert.match(rebind.body,/HOST_DENIED/);
  // Session check is untouched: same-origin API call without the session cookie is refused.
  const noSession=await h.raw('/api/settings',{'Sec-Fetch-Site':'same-origin','X-Yoisaki-Local':'1'});assert.equal(noSession.status,401);
 }finally{await h.close()}
 function route(r){return r}
});

test('isAppNavigation accepts only GET + navigate + document to app pages without OAuth parameters',()=>{
 const u=s=>new URL(s,'http://127.0.0.1:3000');const r=h=>({headers:h});const n={'sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
 assert.equal(isAppNavigation(r(n),'GET','/generate',u('/generate')),true);
 assert.equal(isAppNavigation(r(n),'GET','/',u('/?lang=ru')),true);
 assert.equal(isAppNavigation(r(n),'POST','/generate',u('/generate')),false);
 assert.equal(isAppNavigation(r({...n,'sec-fetch-dest':'iframe'}),'GET','/generate',u('/generate')),false);
 assert.equal(isAppNavigation(r({...n,'sec-fetch-mode':'cors'}),'GET','/generate',u('/generate')),false);
 assert.equal(isAppNavigation(r(n),'GET','/api/session',u('/api/session')),false);
 assert.equal(isAppNavigation(r(n),'GET','/',u('/?state=abc')),false);
 assert.equal(isAppNavigation(r({}),'GET','/generate',u('/generate')),false);
});
