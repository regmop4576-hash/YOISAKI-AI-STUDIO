// Builds the installation ZIP from the working tree: production build, package-manifest.json, archive.
//   node scripts/make-release.mjs OUTPUT.zip
// The folder inside the ZIP keeps the historical name YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION (expected by update.sh).
// Never packs node_modules, git metadata, local data or secrets (same rules as .gitignore).
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.resolve(process.argv[2]||'YOISAKI_AI_STUDIO_RELEASE.zip');
const FOLDER='YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION';
const SKIP=new Set(['.git','node_modules','validation','screenshots','.pytest_cache','__pycache__']);
const FORBIDDEN=[/(^|\/)secrets\.json/,/(^|\/)state\.json/,/\.token$/,/(^|\/)rclone\.conf$/,/(^|\/)config\/google-desktop-client\.json$/,/(^|\/)\.env(\.|$)/,/\.zip$/,/(^|\/)build-meta\.json$/,/\.pyc$/];
async function walk(dir){const out=[];for(const e of await fs.readdir(path.join(root,dir),{withFileTypes:true})){if(SKIP.has(e.name))continue;const rel=dir?dir+'/'+e.name:e.name;if(e.isSymbolicLink())throw Error('symlink: '+rel);if(e.isDirectory())out.push(...await walk(rel));else if(e.isFile())out.push(rel)}return out}
execFileSync('npm',['run','build'],{cwd:root,stdio:'inherit'});
const files=(await walk('')).filter(f=>f!=='package-manifest.json'&&!FORBIDDEN.some(r=>r.test(f))).sort();
const stage=await fs.mkdtemp(path.join(os.tmpdir(),'yoisaki-release-'));
try{
 const target=path.join(stage,FOLDER);
 for(const name of files){const dest=path.join(target,name);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.copyFile(path.join(root,name),dest);await fs.chmod(dest,(await fs.stat(path.join(root,name))).mode&0o777)}
 // Hash the final staged bytes, after the production build and all copying.
 const manifest={};
 for(const name of files){let data=await fs.readFile(path.join(target,name));if(name.endsWith('.sh'))data=Buffer.from(data.toString().replace(/^#![^\n]+/,'#!/usr/bin/env bash'));manifest[name]=createHash('sha256').update(data).digest('hex')}
 await fs.writeFile(path.join(target,'package-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 const verify=dir=>{for(const script of ['verify-package.mjs','build-identity.mjs'])execFileSync(process.execPath,['scripts/'+script],{cwd:dir,stdio:'inherit'})};
 verify(target);
 // Do not publish an archive until its extracted contents pass both checks.
 const packed=path.join(stage,'release.zip'), extracted=path.join(stage,'extracted');
 execFileSync('zip',['-q','-r','-X',packed,FOLDER],{cwd:stage});
 execFileSync('unzip',['-tq',packed],{stdio:'inherit'});
 execFileSync('unzip',['-q',packed,'-d',extracted]);
 verify(path.join(extracted,FOLDER));
 await fs.copyFile(packed,output);
 await fs.copyFile(path.join(target,'package-manifest.json'),path.join(root,'package-manifest.json'));
 console.log(`${path.basename(output)}: ${files.length+1} files, sha256 ${createHash('sha256').update(await fs.readFile(output)).digest('hex')}`);
}finally{await fs.rm(stage,{recursive:true,force:true})}
