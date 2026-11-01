import sys,os,json,hashlib,re,subprocess,shutil,zipfile
src_zip,out_zip,version,mode=sys.argv[1:5]
work=out_zip+'.d'; shutil.rmtree(work,ignore_errors=True); os.makedirs(work)
with zipfile.ZipFile(src_zip) as z: z.extractall(work)
app=os.path.join(work,'YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION')
p=json.load(open(app+'/package.json')); p['version']=version
open(app+'/package.json','w').write(json.dumps(p,indent=2)+'\n')
if mode=='broken':
    s=open(app+'/server/index.mjs').read(); open(app+'/server/index.mjs','w').write("throw new Error('TEST: broken release');\n"+s)
subprocess.run(['node','-e',"import('./scripts/build-identity.mjs').then(m=>m.writeBuildIdentity()).then(x=>console.log(JSON.stringify(x)))"],cwd=app,check=True)
man={}
for r,d,f in os.walk(app):
    for x in f:
        rel=os.path.relpath(os.path.join(r,x),app)
        if rel=='package-manifest.json': continue
        data=open(os.path.join(r,x),'rb').read()
        if rel.endswith('.sh'): data=re.sub(rb'^#![^\n]+',b'#!/usr/bin/env bash',data,count=1)
        man[rel]=hashlib.sha256(data).hexdigest()
json.dump(dict(sorted(man.items())),open(app+'/package-manifest.json','w'),indent=2)
if os.path.exists(out_zip): os.remove(out_zip)
subprocess.run(['zip','-qr','-X',os.path.abspath(out_zip),'YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION'],cwd=work,check=True)
shutil.rmtree(work)
