import http from 'node:http';import fs from 'node:fs';import crypto from 'node:crypto';import path from 'node:path';
const W=process.env.ITEST_DIR;const dir=path.join(W,"art"),cfgf=path.join(W,"mock-config.json"),logf=path.join(W,"mock.log"),base='http://127.0.0.1:18080';
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
let truncated=new Set();
http.createServer((req,res)=>{
 const cfg=JSON.parse(fs.readFileSync(cfgf,'utf8'));fs.appendFileSync(logf,`${req.method} ${req.url} range=${req.headers.range||'-'}\n`);
 const u=new URL(req.url,base);
 if(u.pathname==='/repos/x/releases/latest'){
  const z=cfg.zip,f=path.join(dir,z);const assets=cfg.noassets?[]:[{name:z,size:fs.statSync(f).size,browser_download_url:`${base}/dl/${z}`,digest:cfg.digest===false?null:'sha256:'+sha(f)},{name:'SHA256SUMS.txt',size:100,browser_download_url:`${base}/dl/SHA256SUMS.txt`,digest:null}];
  res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({tag_name:cfg.tag||'v-test',name:cfg.name||'Test release',draft:false,prerelease:false,assets}));}
 if(u.pathname==='/install-termux.sh'){res.writeHead(200);return res.end(fs.readFileSync(cfg.installer));}
 if(u.pathname==='/dl/SHA256SUMS.txt'){const h=cfg.badsum?'0'.repeat(64):sha(path.join(dir,cfg.zip));res.writeHead(200);return res.end(`${h}  ${cfg.zip}\n`);}
 if(u.pathname.startsWith('/dl/')){const f=path.join(dir,path.basename(u.pathname));if(!fs.existsSync(f)){res.writeHead(404);return res.end()}
  const data=fs.readFileSync(f);let start=0;const m=/bytes=(\d+)-/.exec(req.headers.range||'');if(m)start=+m[1];
  if(cfg.truncate_once&&!truncated.has(f)){truncated.add(f);res.writeHead(200,{'content-length':data.length});res.write(data.subarray(0,Math.floor(data.length/2)));return setTimeout(()=>res.destroy(),50);}
  if(start){res.writeHead(206,{'content-range':`bytes ${start}-${data.length-1}/${data.length}`,'content-length':data.length-start});return res.end(data.subarray(start));}
  res.writeHead(200,{'content-length':data.length});return res.end(data);}
 res.writeHead(404);res.end();
}).listen(18080,'127.0.0.1',()=>console.log('mock up'));
