import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function files(dir){const out=[];for(const e of await fs.readdir(path.join(root,dir),{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())out.push(...await files(p));else if(e.isFile())out.push(p)}return out;}
export async function sourceIdentity(){
 const names=['package.json','package-lock.json','tsconfig.json',...await files('src'),...await files('public'),...await files('server'),...await files('scripts')].sort();
 const hash=createHash('sha256');for(const name of names){hash.update(name+'\0');hash.update(await fs.readFile(path.join(root,name)));}
 const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
 return {version:pkg.version,source_sha256:hash.digest('hex')};
}
export async function writeBuildIdentity(){
 const identity=await sourceIdentity();const outputs={};
 for(const name of (await files('dist')).filter(x=>x!=='dist/release.json').sort())outputs[name]=createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex');
 await fs.writeFile(path.join(root,'dist/release.json'),JSON.stringify({...identity,outputs},null,2));return identity;
}
export async function checkBuild(){
 const built=JSON.parse(await fs.readFile(path.join(root,'dist/release.json'),'utf8'));const actual=await sourceIdentity();
 if(built.version!==actual.version||built.source_sha256!==actual.source_sha256||!Object.keys(built.outputs||{}).length)throw Error('Production build does not match installed sources. Run bash install.sh.');
 for(const [name,hash] of Object.entries(built.outputs)){if(!name.startsWith('dist/')||name.includes('..')||createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex')!==hash)throw Error('Production assets differ. Run bash install.sh.');}
 return actual;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{console.log(JSON.stringify(await checkBuild()))}catch(e){console.error(e.message);process.exitCode=1}
