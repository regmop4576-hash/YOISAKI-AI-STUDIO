// v1.7.3 secret audit for a source tree, build output or an unpacked release archive.
// Usage: node scripts/secret-audit.mjs [folder]   (default: the app folder). Exit 1 = something must be removed.
// Test fixtures use obvious fake markers (TESTONLY, BROWSERTEST, abcdefghij…) and are reported only if they look real.
import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(process.argv[2]||path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));
const SKIP_DIRS=new Set(['node_modules','.git','__pycache__','.pytest_cache','.venv']);
// Files that must never be in a repository or archive (per-installation credentials and state).
const FORBIDDEN=/^(secrets\.json.*|state\.json.*|rclone\.conf|engine\.token|cloudflared\.token|yoisaki\.env|\.env|google-oauth-client\.json|cloudcompute-api\.json)$/;
const PATTERNS=[
 ['CloudCompute API key',/\bcc-[A-Za-z0-9._~-]{16,}/g],
 ['Google OAuth client secret',/GOCSPX-[A-Za-z0-9_-]{10,}/g],
 ['Google access token',/ya29\.[A-Za-z0-9._-]{20,}/g],
 ['Google refresh token',/(?<![A-Za-z0-9+])1\/\/0[A-Za-z0-9_-]{20,}/g],
 ['Google OAuth client ID',/\b\d{8,}-[a-z0-9]{24,}\.apps\.googleusercontent\.com/g],
 ['YOISAKI engine link with token',/#token=[a-f0-9]{64}/g],
 ['Private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
 ['GitHub token',/\bgh[pousr]_[A-Za-z0-9]{30,}/g],
 ['Hugging Face token',/\bhf_[A-Za-z0-9]{30,}/g],
];
const FAKE=/TESTONLY|BROWSERTEST|SECRETS|EXAMPLE|abcdefghij|x{10,}|0{12}|REPLACE_ME|\[СКРЫТО\]|(.)\1{15}/i;
const findings=[];
async function walk(dir){
 for(const e of await fs.readdir(dir,{withFileTypes:true})){
  const p=path.join(dir,e.name),rel=path.relative(root,p);
  if(e.isDirectory()){if(!SKIP_DIRS.has(e.name))await walk(p);continue}
  if(!e.isFile())continue;
  if(FORBIDDEN.test(e.name)&&!/\.example\./.test(e.name)){findings.push({file:rel,kind:'credential/state file must not be distributed'});continue}
  const stat=await fs.stat(p);if(stat.size>20*1024*1024)continue;
  const text=(await fs.readFile(p)).toString('latin1');
  for(const [kind,re] of PATTERNS)for(const m of text.matchAll(re)){
   const around=text.slice(Math.max(0,m.index-40),m.index+m[0].length+40);
   if(FAKE.test(m[0])||FAKE.test(around)&&/tests?\//.test(rel))continue;
   findings.push({file:rel,kind,sample:m[0].slice(0,12)+'…'});
  }
 }
}
await walk(root);
if(findings.length){console.error('Secret audit FAILED:');for(const f of findings)console.error(` - ${f.file}: ${f.kind}${f.sample?' ('+f.sample+')':''}`);process.exit(1)}
console.log('Secret audit: OK ('+root+')');
