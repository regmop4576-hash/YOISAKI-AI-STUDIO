import sys,tempfile,gc,io,json,uuid,os
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
from worker.results import ResultStore
import numpy as np
from PIL import Image
mode=sys.argv[1];retained=[];rows=[]
def rss():return int(Path('/proc/self/statm').read_text().split()[1])*os.sysconf('SC_PAGE_SIZE')
with tempfile.TemporaryDirectory() as d:
 store=ResultStore(d)
 for i in range(10):
  im=Image.fromarray(np.random.default_rng(i).integers(0,256,(1024,1024,3),dtype=np.uint8))
  if mode=='baseline':
   b=io.BytesIO();im.save(b,format='PNG');retained.append(b.getvalue());b.close();del b
  else:
   ident=str(uuid.uuid4());store.reserve(ident,1);store.save(ident,[im],i)
  im.close();del im;gc.collect()
  rows.append({'iteration':i+1,'rss_bytes':rss(),'png_ram_bytes':sum(map(len,retained)),'png_disk_bytes':store.bytes_used()})
print(json.dumps({'mode':mode,'test':'PNG storage ONLY, not diffusion','rows':rows}))
