// Local HTTPS transport test. Test-only self-signed certificate, no actual tunnel or GPU.
import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {test} from 'node:test';import assert from 'node:assert/strict';import https from 'node:https';import fs from 'node:fs/promises';import {requestUpstream,parseTunnel} from '../server/upstream.mjs';
test('actual HTTPS carries Bearer, refuses redirects, classifies 401/malformed response/timeout',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-tls-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem'),'-days','1','-subj','/CN=unit-test.trycloudflare.com','-addext','subjectAltName=DNS:unit-test.trycloudflare.com,DNS:compute.example.com'],{stdio:'ignore'});
 const key=await fs.readFile(path.join(dir,'key.pem')),cert=await fs.readFile(path.join(dir,'cert.pem'));let mode='ok',received='';
 const server=https.createServer({key,cert},(req,res)=>{received=req.headers.authorization;if(mode==='timeout')return;if(mode==='redirect'){res.writeHead(302,{Location:'http://169.254.169.254/'});return res.end()}if(mode==='auth'){res.writeHead(401);return res.end('{}')}if(mode==='html')return res.end('<html>not an engine</html>');res.setHeader('Content-Type','application/json');res.end('{"engine":"YOISAKI_ENGINE"}')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const token='f'.repeat(64),c=parseTunnel('https://unit-test.trycloudflare.com/#token='+token);
 // Only this test injects localhost transport and trusted self-signed CA. Production always uses public pinned DNS + system TLS.
 const options={lookup:async()=>[{address:'1.1.1.1',family:4}],transport:(o,cb)=>https.request({...o,port:server.address().port,ca:cert,lookup:(_h,opt,cb)=>opt.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4)},cb)};
 try{const cloud=parseTunnel('https://compute.example.com/#token='+token,'cloudcompute');assert.equal((await requestUpstream(cloud,'/health',options)).engine,'YOISAKI_ENGINE');assert.equal((await requestUpstream(c,'/health',options)).engine,'YOISAKI_ENGINE');assert.equal(received,'Bearer '+token);
 for(const [m,code] of [['redirect','REDIRECT_REJECTED'],['auth','AUTH_REJECTED'],['html','INVALID_RESPONSE'],['timeout','CONNECTION_TIMEOUT']]){mode=m;for(const conn of [c,cloud])await assert.rejects(()=>requestUpstream(conn,'/health',{...options,timeout:m==='timeout'?50:3000}),e=>e.code===code)}
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true})}
});
