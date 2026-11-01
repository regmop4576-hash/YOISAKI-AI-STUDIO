"""Native widget panel. No injected JavaScript; standard long-press copy on Android."""
import atexit, html, json, os, re, secrets, subprocess, threading, time, traceback, urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parent
MODEL_ROOT=Path('/content/drive/MyDrive/YOISAKI_AI_STUDIO/models')
PYTHON=ROOT/'.venv/bin/python'
def gpu():
    try:
        import torch
        if torch.cuda.is_available():
            free,total=torch.cuda.mem_get_info()
            return {'name':torch.cuda.get_device_name(),'free':round(free/2**20),'total':round(total/2**20),'cuda':True}
    except Exception:pass
    return {'name':'GPU недоступен','free':None,'total':None,'cuda':False}
def fetch(url,token,timeout=8):
    req=urllib.request.Request(url,headers={'Authorization':'Bearer '+token})
    with urllib.request.urlopen(req,timeout=timeout) as r:return json.load(r)
def download_tunnel():
    import platform,hashlib
    arch={'x86_64':'amd64','aarch64':'arm64'}.get(platform.machine())
    if not arch:raise RuntimeError('Архитектура cloudflared не поддерживается')
    name='cloudflared-linux-'+arch
    req=urllib.request.Request('https://api.github.com/repos/cloudflare/cloudflared/releases/latest',headers={'User-Agent':'YOISAKI-ENGINE'})
    with urllib.request.urlopen(req,timeout=30) as r:release=json.load(r)
    asset=next(x for x in release['assets'] if x['name']==name)
    target=ROOT/'cloudflared';temporary=ROOT/'cloudflared.part'
    with urllib.request.urlopen(asset['browser_download_url'],timeout=60) as r,temporary.open('wb') as f:
        while chunk:=r.read(1024*1024):f.write(chunk)
    digest=asset.get('digest')
    if digest and digest.startswith('sha256:') and hashlib.sha256(temporary.read_bytes()).hexdigest()!=digest.split(':',1)[1]:
        temporary.unlink();raise RuntimeError('Контрольная сумма cloudflared не совпала')
    temporary.chmod(0o700);temporary.replace(target)
    return target
class Controller:
    def __init__(self):
        self.server=None;self.tunnel=None;self.token='';self.url='';self.verified=False;self.lock=threading.RLock();self.log_handles=[]
        atexit.register(self.stop)
    def stop(self):
        with self.lock:
            self.url='';self.verified=False
            for p in (self.tunnel,self.server):
                if p and p.poll() is None:
                    p.terminate()
                    try:p.wait(timeout=15)
                    except subprocess.TimeoutExpired:p.kill();p.wait(timeout=5)
            self.server=self.tunnel=None;self.token=''
            for f in self.log_handles:f.close()
            self.log_handles=[]
    def start(self):
        with self.lock:
            if self.server and self.server.poll() is None and self.verified:return self.url
            self.stop()
            if not gpu()['cuda']:raise RuntimeError('GPU недоступен. Среда выполнения → Сменить среду → T4 GPU, затем повторите установку.')
            if not Path('/content/drive/MyDrive').is_dir():raise RuntimeError('Не удалось подключить Google Drive. Нажмите «Подключить Drive» и разрешите доступ.')
            from worker.models import scan
            if not any(m['kind']=='checkpoint' and m['compatible'] is not False for m in scan(MODEL_ROOT)):
                raise RuntimeError('Модель не найдена или несовместима. Добавьте SDXL / Illustrious XL .safetensors в models/checkpoints и обновите модели.')
            binary=ROOT/'cloudflared'
            if not binary.exists():binary=download_tunnel()
            self.token=secrets.token_hex(32)
            from worker.allocator_policy import worker_environment
            env=worker_environment(os.environ);env.update(YOISAKI_TOKEN=self.token,YOISAKI_MODEL_ROOT=str(MODEL_ROOT),PYTHONPATH=str(ROOT))
            try:
                f=(ROOT/'server.log').open('w');self.log_handles.append(f)
                self.server=subprocess.Popen([str(PYTHON),'-m','worker.serve'],cwd=ROOT,env=env,stdout=f,stderr=subprocess.STDOUT)
                for _ in range(60):
                    if self.server.poll() is not None:raise RuntimeError('Сервер не запустился. Откройте диагностику и повторите установку.')
                    try:
                        if fetch('http://127.0.0.1:8765/health',self.token)['state']=='READY':break
                    except Exception:pass
                    time.sleep(1)
                else:raise RuntimeError('Сервер не ответил за 60 секунд.')
                f=(ROOT/'tunnel.log').open('w');self.log_handles.append(f)
                self.tunnel=subprocess.Popen([str(binary),'tunnel','--no-autoupdate','--protocol','http2','--url','http://127.0.0.1:8765'],stdout=f,stderr=subprocess.STDOUT)
                base=None
                for _ in range(90):
                    if self.tunnel.poll() is not None:raise RuntimeError('Туннель завершился. Нажмите «Запустить» ещё раз; подробности в диагностике.')
                    match=re.search(r'https://[a-z0-9-]+\.trycloudflare\.com',(ROOT/'tunnel.log').read_text(errors='replace'))
                    if match:
                        base=match.group(0)
                        try:
                            if fetch(base+'/health',self.token,3).get('engine')=='YOISAKI_ENGINE':break
                        except Exception:pass
                    time.sleep(1)
                else:raise RuntimeError('Cloudflare не подтвердил соединение. Повторите запуск через минуту.')
                self.url=base+'/#token='+self.token;self.verified=True
                return self.url
            except Exception:self.stop();raise
class Panel:
    def __init__(self):
        import ipywidgets as w
        self.w=w;self.controller=Controller();self.busy=False;self.closed=False;self.last_error='';self.latest_trace=''
        self.status=w.HTML();self.error=w.HTML();self.link=w.Textarea(value='',placeholder='Ссылка появится после проверки соединения',layout=w.Layout(width='100%',height='82px'))
        self.diagnostics=w.HTML();self.accordion=w.Accordion(children=[self.diagnostics],selected_index=None);self.accordion.set_title(0,'🔧 Диагностика — по запросу')
        self.accordion.observe(lambda c:self.diagnose() if c['new']==0 else None,names='selected_index')
        self.buttons=[]
        for label,fn,style in [('🚀 ЗАПУСТИТЬ ДВИЖОК',self.start,'warning'),('🛑 ОСТАНОВИТЬ',self.stop,'danger'),('🔄 ОБНОВИТЬ МОДЕЛИ',self.refresh,''),('📁 Подключить Drive',self.mount,'')]:
            b=w.Button(description=label,button_style=style,layout=w.Layout(width='100%',height='44px'));b.on_click(lambda _,fn=fn:self.action(fn));self.buttons.append(b)
        header=w.HTML('<div style="background:#17191e;color:#ffe3a2;padding:16px;border-radius:14px;border:1px solid #9b6425"><b style="font-size:22px">🦊 YOISAKI ENGINE</b><br>v1.7.0 · GPU-панель<br><small>SDXL / Illustrious XL · личная сессия</small></div>')
        self.widget=w.VBox([header,self.status,*self.buttons,self.error,w.HTML('<b>🔗 Подключение к AI STUDIO</b><br>Удерживайте поле → Выделить всё → Копировать. Ссылка содержит секрет; не публикуйте её.'),self.link,self.accordion],layout=w.Layout(width='100%',max_width='620px'))
        self.refresh()
    def show(self):
        from IPython.display import display
        display(self.widget)
    def action(self,fn):
        if self.busy:return
        self.busy=True
        for b in self.buttons:b.disabled=True
        try:fn();self.last_error='';self.error.value=''
        except Exception as e:
            self.latest_trace=traceback.format_exc();self.last_error=str(e)
            self.error.value='<div style="padding:12px;border:1px solid #d69332">⚠ '+html.escape(str(e))+'</div>'
        finally:
            self.busy=False
            for b in self.buttons:b.disabled=False
            self.refresh_status()
    def mount(self):
        from google.colab import drive
        if not Path('/content/drive/MyDrive').is_dir():drive.mount('/content/drive')
        if not Path('/content/drive/MyDrive').is_dir():raise RuntimeError('Не удалось подключить Google Drive. Повторите подключение и разрешите доступ.')
        # Only create absent directories; never rewrite user models or metadata.
        for folder in ('checkpoints','loras','vae'):(MODEL_ROOT/folder).mkdir(parents=True,exist_ok=True)
        self.refresh()
    def start(self):
        self.error.value='⏳ Запускаю сервер и проверяю Cloudflare…'
        self.link.value=self.controller.start()
        # Monitor process exits; links are cleared as soon as a managed process dies.
        threading.Thread(target=self.watch,daemon=True).start()
    def watch(self):
        session=self.controller.token
        ticks=0;failures=0
        while not self.closed and self.controller.verified and self.controller.token==session:
            time.sleep(5)
            if self.controller.token!=session:break
            ticks+=1
            if ticks%6==0 and self.controller.verified:
                try:
                    fetch(self.controller.url.split('/#')[0]+'/health',self.controller.token,5);failures=0
                except Exception:failures+=1
            if failures>=3 or any(p is None or p.poll() is not None for p in (self.controller.server,self.controller.tunnel)):
                self.controller.stop();self.link.value='';self.error.value='⚠ Соединение завершилось. Нажмите «Запустить движок».';self.refresh_status();break
    def stop(self):self.controller.stop();self.link.value=''
    def refresh(self):
        from worker.models import scan
        self.models=scan(MODEL_ROOT);self.refresh_status()
    def refresh_status(self):
        g=gpu();drive=Path('/content/drive/MyDrive').is_dir();c=self.controller
        count=lambda k:sum(x['kind']==k for x in getattr(self,'models',[]))
        values=[('🖥 GPU',g['name']),('VRAM свободно / всего',f"{g['free']} / {g['total']} МБ" if g['cuda'] else '—'),('CUDA','доступна' if g['cuda'] else 'недоступна'),('Среда','Python активен'),('📁 Google Drive','подключён' if drive else 'не подключён'),('Каталог моделей','найден' if MODEL_ROOT.is_dir() else 'не найден'),('🧩 Модели',f"Checkpoints: {count('checkpoint')} · LoRA: {count('lora')} · VAE: {count('vae')}"),('Сервер','работает' if c.server and c.server.poll() is None else 'остановлен'),('Туннель','работает' if c.tunnel and c.tunnel.poll() is None else 'отключён'),('Проверка подключения','успешно при запуске' if c.verified else 'не выполнена')]
        self.status.value='<div style="background:#202228;color:#f4f0e6;padding:12px;border-radius:12px">'+''.join('<div style="padding:5px 0"><b style="color:#ffc66b">'+html.escape(k)+'</b><br>'+html.escape(v)+'</div>' for k,v in values)+'</div>'
    def diagnose(self):
        text=self.latest_trace
        for name in ('setup.log','server.log','tunnel.log'):
            p=ROOT/name
            if p.exists():text+='\n'+name+'\n'+p.read_text(errors='replace')[-16000:]
        if self.controller.token:text=text.replace(self.controller.token,'[СКРЫТО]')
        self.diagnostics.value='<pre style="white-space:pre-wrap;overflow-wrap:anywhere">'+html.escape(text or 'Ошибок не зарегистрировано.')+'</pre>'
    def close(self):self.closed=True;self.stop();self.widget.close()
