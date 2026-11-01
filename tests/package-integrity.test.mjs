import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
const hash=s=>createHash('sha256').update(s).digest('hex');
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-integrity-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.mkdir(path.join(dir,'scripts'));
 await fs.copyFile(new URL('../scripts/verify-package.mjs',import.meta.url),path.join(dir,'scripts/verify-package.mjs'));
 const source='#!/usr/bin/env bash\necho installed\n';
 await fs.writeFile(path.join(dir,'install.sh'),source);
 await fs.writeFile(path.join(dir,'asset.js'),'original');
 const manifest={'install.sh':hash(source),'asset.js':hash('original')};
 const write=()=>fs.writeFile(path.join(dir,'package-manifest.json'),JSON.stringify(manifest));
 await write();
 const check=()=>run(process.execPath,[path.join(dir,'scripts/verify-package.mjs')],{cwd:os.tmpdir()});
 return {dir,manifest,write,check};
}
test('integrity checks its own package, including when invoked from another directory',async t=>{
 const f=await fixture(t);assert.match((await f.check()).stdout,/OK \(2\)/);
});
test('modified and missing files fail together with exact paths and hashes',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.dir,'asset.js'),'changed');await fs.rm(path.join(f.dir,'install.sh'));
 await assert.rejects(f.check(),e=>e.code===1&&e.stderr.includes('install.sh: файл отсутствует')&&e.stderr.includes('asset.js: SHA-256')&&e.stderr.includes(hash('changed')));
});
test('Termux interpreter rewrite passes; changed shell commands still fail',async t=>{
 const f=await fixture(t),p=path.join(f.dir,'install.sh');
 await fs.writeFile(p,'#!/data/data/com.termux/files/usr/bin/bash\necho installed\n');await f.check();
 await fs.appendFile(p,'echo modified\n');await assert.rejects(f.check(),e=>e.code===1&&e.stderr.includes('install.sh: SHA-256'));
});
test('empty, malformed and unsafe manifests fail closed',async t=>{
 const f=await fixture(t);
 for(const manifest of ['{}','[]','null','{','{"../outside":"'+hash('x')+'"}','{"asset.js":"invalid"}']){
  await fs.writeFile(path.join(f.dir,'package-manifest.json'),manifest);await assert.rejects(f.check(),e=>e.code===1);
 }
});
