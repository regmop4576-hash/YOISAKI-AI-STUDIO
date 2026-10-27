"""Disk-backed results. Unacknowledged results are NEVER evicted for TTL/quota.
Pressure refuses new work. ACK is sent only after the site's durable gallery save.
"""
import os,time,tempfile,threading,shutil,json,re
from pathlib import Path

class ResultStore:
    def __init__(self,root=None,limit=1024**3,ttl=86400):
        self.root=Path(root or os.environ.get('YOISAKI_RESULTS_DIR') or Path(__file__).resolve().parents[1]/'.results')
        self.root.mkdir(parents=True,exist_ok=True);self.lock=threading.RLock()
        self.limit=limit;self.ttl=ttl;self.entries={};self.reservations={}
        self.index=self.root/'index.json'
        if self.index.exists():
            # Fail closed on a broken index; never delete unacknowledged files to recover space.
            saved=json.loads(self.index.read_text())
            for ident,e in saved.items():
                if not re.fullmatch(r'[a-f0-9-]{36}',ident):raise ValueError('Invalid result index')
                paths=[self.root/(ident+'_'+str(i)+'.png') for i in range(e['count'])]
                if all(p.is_file() for p in paths):self.entries[ident]={**e,'paths':paths}
    def persist(self):
        data={k:{field:v for field,v in e.items() if field!='paths'} for k,e in self.entries.items()}
        temp=self.index.with_suffix('.tmp')
        with temp.open('w') as f:json.dump(data,f);f.flush();os.fsync(f.fileno())
        os.replace(temp,self.index)
    def restored_jobs(self):
        return {ident:{'id':ident,'status':'COMPLETED','created':e['created'],
                'progress':{'stage':'DONE'},'result':{'seed':e['seed'],'image_keys':[str(i) for i in range(e['count'])]}}
                for ident,e in self.entries.items()}
    def bytes_used(self):
        with self.lock:return sum(p.stat().st_size for p in self.root.glob('*.png'))
    def cleanup(self):
        with self.lock:
            for ident,e in list(self.entries.items()):
                if e['ack'] is not None and time.time()-e['ack']>=self.ttl:
                    for p in e['paths']:p.unlink(missing_ok=True)
                    del self.entries[ident]
                    self.persist()
    def reserve(self,ident,count):
        with self.lock:
            self.cleanup();budget=count*25*1024*1024
            reserved=sum(self.reservations.values())
            if self.bytes_used()+reserved+budget>self.limit or shutil.disk_usage(self.root).free<reserved+budget+256*1024*1024:
                raise ValueError('Temporary result disk full; collect results and wait for acknowledged-result cleanup')
            self.reservations[ident]=budget
    def save(self,ident,images,seed=0):
        paths=[]
        try:
            for i,im in enumerate(images):
                target=self.root/(ident+'_'+str(i)+'.png');temporary=target.with_suffix('.tmp')
                try:
                    with temporary.open('wb') as f:im.save(f,format='PNG');f.flush();os.fsync(f.fileno())
                    paths.append(target);os.replace(temporary,target)
                finally:temporary.unlink(missing_ok=True)
            size=sum(p.stat().st_size for p in paths)
            with self.lock:
                if size>self.reservations.get(ident,0):raise ValueError('Result exceeds reserved disk budget')
                self.entries[ident]={'paths':paths,'size':size,'ack':None,'seed':seed,'count':len(paths),'created':time.time()};self.persist();self.reservations.pop(ident,None)
        except BaseException:
            with self.lock:self.entries.pop(ident,None)
            for p in paths:p.unlink(missing_ok=True)
            self.release(ident);raise
    def release(self,ident):
        with self.lock:self.reservations.pop(ident,None)
    def discard(self,ident):
        # Only for failed/cancelled unpublished jobs.
        with self.lock:
            e=self.entries.pop(ident,None)
            if e:
                for p in e['paths']:p.unlink(missing_ok=True)
            self.release(ident)
            self.persist()
    def ack(self,ident):
        with self.lock:
            if ident in self.entries and self.entries[ident]['ack'] is None:self.entries[ident]['ack']=time.time();self.persist()
    def open(self,ident,index):
        with self.lock:
            e=self.entries.get(ident)
            if not e or index<0 or index>=len(e['paths']):raise FileNotFoundError()
            return e['paths'][index].open('rb')
