// Writes package-manifest.json (SHA-256 of every distributed source file) checked by scripts/verify-package.mjs.
// Build output (dist/, checked separately by build-identity.mjs), dependencies, caches and local test output are excluded,
// so the same manifest is valid for the release ZIP and for a clone of the GitHub repository.
import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
const SKIP=new Set(['node_modules','.git','dist','__pycache__','.pytest_cache','validation','screenshots','.venv','.results']);
const SKIP_FILES=new Set(['package-manifest.json','build-meta.json','mobile-results.json']);
async function files(dir){const out=[];for(const e of await fs.readdir(dir||'.',{withFileTypes:true})){const p=dir?dir+'/'+e.name:e.name;if(e.isDirectory()){if(!SKIP.has(e.name))out.push(...await files(p))}else if(e.isFile()&&!SKIP_FILES.has(e.name)&&!e.name.endsWith('.zip'))out.push(p)}return out}
const manifest={};
for(const name of (await files('')).sort()){let data=await fs.readFile(name);if(name.endsWith('.sh'))data=Buffer.from(data.toString().replace(/^#![^\n]+/,'#!/usr/bin/env bash'));manifest[name]=createHash('sha256').update(data).digest('hex')}
await fs.writeFile('package-manifest.json',JSON.stringify(manifest,null,2)+'\n');console.log('package-manifest.json: '+Object.keys(manifest).length+' files');
