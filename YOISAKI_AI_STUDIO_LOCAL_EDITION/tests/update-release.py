from pathlib import Path
import subprocess,os,tempfile,zipfile,json,urllib.request,hashlib,shutil,sys
base=Path(tempfile.mkdtemp(prefix='yoisaki-update-'))
baseline=Path(sys.argv[1]).resolve()
release=Path(sys.argv[2]).resolve()
app=base/'installed';data=base/'user-data';stage=base/'new'
data.mkdir();(data/'images').mkdir();image_id='11111111-1111-4111-8111-111111111111_0'
(data/'images'/image_id).write_bytes(b'user-image-preservation-test')
state={'version':1,'settings':{'state':{'language':'English','presets':[{'id':'keep','name':'keep-me','version':1,'settings':{'prompt':'my prompt'}}]},'version':2},'models':[{'id':'a'*32,'name':'USER MODEL','kind':'checkpoint'}],'tags':{'a'*32:{'trigger_words':['vesperfox']}},'gallery':[{'id':image_id,'name':'my image','favorite':True}],'history':[{'id':image_id[:-2],'status':'COMPLETED','created':1,'updated':1,'request':{'prompt':'keep history'}}],'preferences':{'last_host':'https://old.trycloudflare.com','user_flag':'preserve'}}
(data/'state.json').write_text(json.dumps(state))
with zipfile.ZipFile(baseline) as z:z.extractall(base/'old')
(base/'old/YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION').rename(app)
(app/'my-custom-file.txt').write_text('user content kept in code backup')
archive=release
with zipfile.ZipFile(archive) as z:z.extractall(stage)
new=stage/'YOISAKI_AI_STUDIO_V1.4.0_LOCAL_EDITION'
env=os.environ|{'YOISAKI_DATA_DIR':str(data),'PORT':'3000'}
def run(args,cwd=None,ok=True):
 r=subprocess.run(args,cwd=cwd,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=90)
 print(r.stdout.strip());
 if ok and r.returncode:raise RuntimeError(f'Command failed {r.returncode}: {args}')
 return r
try:
 run(['bash','start.sh'],app)
 request=urllib.request.Request('http://127.0.0.1:3000/api/session',headers={'X-Yoisaki-Local':'1'})
 old_version=json.loads((app/'package.json').read_text())['version']
 with urllib.request.urlopen(request) as response:assert json.load(response)['version']==old_version
 print(f'PASS baseline old server {old_version} on port 3000')
 run(['bash',str(new/'update.sh'),str(archive),str(app)])
 with urllib.request.urlopen(request) as response:
  assert json.load(response)['version']=='1.7.3';cookie=response.headers['Set-Cookie'].split(';')[0]
 with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:3000/api/version',headers={'X-Yoisaki-Local':'1','Cookie':cookie})) as response:assert json.load(response)['studio_version']=='1.7.3'
 actual=json.loads((data/'state.json').read_text());assert actual==state
 assert (data/'images'/image_id).read_bytes()==b'user-image-preservation-test'
 backups=list(base.glob('installed.backup-*'));assert len(backups)==1
 assert (backups[0]/'my-custom-file.txt').read_text()=='user content kept in code backup'
 data_backups=list(base.glob('user-data.backup-*'));assert len(data_backups)==1
 assert json.loads((data_backups[0]/'state.json').read_text())==state
 print('PASS update preserved gallery bytes, favorites, history, presets, settings, models, tags and custom content; code/data backups exist')
 run(['node','scripts/build-identity.mjs'],app)
 run(['bash','diagnostics.sh'],app)
 # Stale source and stale assets must be rejected before starting.
 run(['bash','stop.sh'],app)
 source=app/'src/lib/release.ts';original=source.read_bytes();source.write_bytes(original+b'\n// stale test\n')
 assert run(['node','scripts/build-identity.mjs'],app,False).returncode!=0;source.write_bytes(original)
 asset=app/'dist/assets/main.js';original=asset.read_bytes();asset.write_bytes(original+b'\n// stale asset\n')
 assert run(['node','scripts/build-identity.mjs'],app,False).returncode!=0;asset.write_bytes(original)
 print('PASS stale source and stale build rejected')
 # Non-destructive manual rollback exactly as documented.
 app.rename(base/'saved-new');shutil.copytree(backups[0],app)
 run(['bash','start.sh'],app)
 with urllib.request.urlopen(request) as response:assert json.load(response)['version']==old_version
 assert (data/'images'/image_id).read_bytes()==b'user-image-preservation-test'
 print(f'PASS manual rollback to old {old_version}, user data unchanged; Linux simulation, not Android hardware')
finally:
 if app.exists():run(['bash','stop.sh'],app,False)
 shutil.rmtree(base)
