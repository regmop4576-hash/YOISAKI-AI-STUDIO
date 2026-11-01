"""Notebook-side sequential real-inference test runner and durable ZIP export.

Uses only *existing* authenticated YOISAKI ENGINE HTTP endpoints and a one-use,
local job-id control file (not an API change). No prompt/token is logged.
"""
from __future__ import annotations
import csv
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import threading
import time
import uuid
import urllib.error
import urllib.request
import zipfile
from worker.memory_profiler import CSV_FIELDS,snapshot

ROOT=Path(__file__).resolve().parents[1]
DEFAULT_BASE='http://127.0.0.1:8765'
REPORT_FILES=('memory_timeline.csv','generation_stages.jsonl','component_memory.json',
              'tensor_analysis.json','allocator_report.json','environment.json','summary_ru.md')
PROMPT='a cheerful red fox in an autumn forest, detailed illustration, clean composition'

def utcnow():return datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
def gib(n):return f'{n/1024**3:.2f} GiB' if isinstance(n,(int,float)) else 'недоступно'
def atomic_json(path,obj):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_name(path.name+'.tmp')
    try:temp.write_text(json.dumps(obj,ensure_ascii=False,indent=2),encoding='utf-8');os.replace(temp,path)
    finally:temp.unlink(missing_ok=True)
def jlines(path):
    p=Path(path)
    if not p.exists():return []
    out=[]
    for line in p.read_text(encoding='utf-8',errors='replace').splitlines():
        try:out.append(json.loads(line))
        except ValueError:pass   # surviving incomplete line after abrupt termination
    return out

def latest_timeline(path):
    try:
        with Path(path).open(newline='',encoding='utf-8') as f:
            row=None
            for row in csv.DictReader(f):pass
        if row is None:return None
        return {k:float(v) if v and k=='time_unix' else (int(v) if v and k.endswith('_bytes') else (v if v else None)) for k,v in row.items()}
    except (OSError,ValueError):return None

def _post_events(folder,event,**kw):
    folder.mkdir(parents=True,exist_ok=True)
    with (folder/'test_events.jsonl').open('a',encoding='utf-8') as f:
        f.write(json.dumps({'utc':datetime.now(timezone.utc).isoformat(),'event':event,**kw},ensure_ascii=False)+'\n')
        f.flush()

class EngineClient:
    def __init__(self,token,base=DEFAULT_BASE):
        if not token:raise RuntimeError('Движок не запущен: отсутствует секрет локальной сессии')
        self._token=token;self.base=base.rstrip('/')
    def call(self,method,path,payload=None,timeout=20):
        body=json.dumps(payload).encode() if payload is not None else None
        headers={'Authorization':'Bearer '+self._token}
        if body is not None:headers['Content-Type']='application/json'
        req=urllib.request.Request(self.base+path,headers=headers,data=body,method=method)
        with urllib.request.urlopen(req,timeout=timeout) as res:return json.loads(res.read())
    def verify_image(self,ident):
        """Reads actual PNG signature over the existing /results endpoint, no image files."""
        import hashlib
        req=urllib.request.Request(self.base+'/results/'+ident+'?index=0',
                                   headers={'Authorization':'Bearer '+self._token})
        with urllib.request.urlopen(req,timeout=120) as res:
            signature=res.read(8);size=len(signature)
            if signature!=b'\x89PNG\r\n\x1a\n':raise ValueError('Non-PNG result')
            while part:=res.read(1024*1024):size+=len(part)
        return size

def _build_request(checkpoint_id,width,height,steps,cfg,seed,ident):
    return dict(client_request_id=ident,kind='text2img',mode='text2img',prompt=PROMPT,
                negative_prompt='',checkpoint_id=checkpoint_id,vae_id='auto',lora_adapters=[],regions=[],
                width=width,height=height,steps=steps,cfg_scale=cfg,sampler='Euler',scheduler='Normal',
                seed=seed,batch_size=1,controlnet_config={'enabled':False})

class DiagnosticRunner:
    def __init__(self,token,checkpoint_id,**options):
        self.client=EngineClient(token)
        self.checkpoint_id=str(checkpoint_id)
        self.options={'count':2,'width':768,'height':768,'steps':20,'cfg':5.0,'seed':123,
                      'sampling_interval':1.0,'detailed_tensors':False,'allocator_test':False,
                      'min_available_gib':2.5,'max_process_rss_gib':10.3,'min_scan_available_gib':2.0,
                      'job_timeout_seconds':2400}
        self.options.update(options)
        self._validate()
        self.run_id=utcnow()+'_'+secrets.token_hex(5)
        self.folder=Path('/content/drive/MyDrive/YOISAKI_AI_STUDIO/diagnostics/reports')/(self.run_id+'.partial')
        self.folder.mkdir(parents=True,exist_ok=False)
        self.cancelled=threading.Event();self.active_job=None
        self.completed=0;self.final_zip=None;self.status='created';self.last_error=None
        self.latest=None
        self._persist_run_state()
    def _validate(self):
        o=self.options
        if len(self.checkpoint_id)!=32 or any(ch not in '0123456789abcdef' for ch in self.checkpoint_id):raise ValueError('Invalid checkpoint ID')
        if not 1<=int(o['count'])<=10:raise ValueError('Generations must be 1–10')
        if int(o['width'])%8 or int(o['height'])%8 or int(o['width'])*int(o['height'])>2*1024**2:raise ValueError('Invalid dimensions')
        if not 1<=int(o['steps'])<=60 or not 1<=float(o['cfg'])<=20:raise ValueError('Invalid steps / CFG')
        if not 0<=int(o['seed'])<=2147483647:raise ValueError('Invalid seed')
        if not .25<=float(o['sampling_interval'])<=10:raise ValueError('Interval must be 0.25–10 seconds')
        if not .5<=float(o['min_available_gib'])<=15 or not 2<=float(o['max_process_rss_gib'])<=30:raise ValueError('Invalid safety threshold')
    def _persist_run_state(self):
        safe={k:v for k,v in self.options.items() if k!='prompt'}
        atomic_json(self.folder/'run_state.json',{'run_id':self.run_id,'completed_generations':self.completed,
           'requested_generations':self.options['count'],'status':self.status,
           'last_error':self.last_error,'options':safe,'active_job':self.active_job,
           'checkpoint_id':self.checkpoint_id,'updated_utc':datetime.now(timezone.utc).isoformat()})
    def _safety(self):
        row=snapshot('preflight',include_full_info=False)
        if row['system_available_bytes'] is None:
            return 'Не удалось измерить свободную RAM; тест остановлен для безопасности'
        # Fixed floor for this unverified 12.7 GiB repair. It rejects the
        # baseline's second job (2.77 GiB free); it cannot prevent an in-op spike.
        required = max(4.0, float(self.options['min_available_gib']))*1024**3
        if row['system_available_bytes'] < required:
            return 'Низкая доступная RAM: '+gib(row['system_available_bytes'])+'; требуется '+gib(required)
        # Process RSS is from the worker, never from the Colab notebook kernel.
        measured=latest_timeline(self.folder/'memory_timeline.csv')
        if measured and measured.get('process_rss_bytes') is not None and measured['process_rss_bytes']>=float(self.options['max_process_rss_gib'])*1024**3:
            return 'RSS рабочего процесса достиг порога: '+gib(measured['process_rss_bytes'])
        return None
    def cancel(self):
        self.cancelled.set()
        if self.active_job:
            try:self.client.call('DELETE','/jobs/'+self.active_job)
            except Exception:pass
    def _control(self,job_id,last):
        config={'run_id':self.run_id,'job_id':job_id,'sampling_interval':float(self.options['sampling_interval']),
                'detailed_tensors':bool(self.options['detailed_tensors']),
                'allocator_test':bool(self.options['allocator_test']) and last,
                'min_scan_available_bytes':int(float(self.options['min_scan_available_gib'])*1024**3),
                'created_unix':time.time()}
        path=ROOT/'.profiler_control'/(job_id+'.json')
        atomic_json(path,config)
        return path
    def _wait_cleanup(self,job_id,max_wait=65):
        deadline=time.monotonic()+max_wait
        while time.monotonic()<deadline:
            if (any(x.get('job_id')==job_id and x.get('stage')=='after_cleanup' for x in jlines(self.folder/'generation_stages.jsonl'))
                and any(x.get('job_id')==job_id and x.get('status')=='profiling_stopped' for x in jlines(self.folder/'job_status.jsonl'))):
                return True
            time.sleep(1)
        return False
    def run(self,progress=lambda data:None):
        self.status='running';self._persist_run_state()
        _post_events(self.folder,'test_started',requested=int(self.options['count']))
        try:
            health=self.client.call('GET','/health')
            if health.get('engine_version') not in ('1.7.0','1.8.0','1.8.1') or not health.get('gpu_name'):
                raise RuntimeError('Требуется работающий CUDA YOISAKI ENGINE v1.7.0')
            models=self.client.call('GET','/models').get('models',[])
            if not any(x.get('id')==self.checkpoint_id and x.get('kind')=='checkpoint' and x.get('compatible') is not False for x in models):
                raise ValueError('Указанный checkpoint отсутствует или несовместим')
            for index in range(int(self.options['count'])):
                if self.cancelled.is_set():self.status='cancelled';break
                reason=self._safety()
                if reason:
                    self.status='safety_stop';self.last_error=reason
                    _post_events(self.folder,'diagnostic_safety_stop',reason=reason)
                    break
                health=self.client.call('GET','/health')
                if health.get('state')!='READY':
                    self.status='stopped_engine_busy';self.last_error='Engine не READY: '+str(health.get('state'))
                    break
                ident=str(uuid.uuid4());self.active_job=ident
                self._persist_run_state()
                control=self._control(ident,index==int(self.options['count'])-1)
                _post_events(self.folder,'generation_started',generation=index+1,job_id=ident)
                try:
                    req=_build_request(self.checkpoint_id,int(self.options['width']),int(self.options['height']),
                        int(self.options['steps']),float(self.options['cfg']),int(self.options['seed']),ident)
                    self.client.call('POST','/generate',req,timeout=60)
                    deadline=time.monotonic()+int(self.options['job_timeout_seconds'])
                    while True:
                        if self.cancelled.is_set():
                            self.client.call('DELETE','/jobs/'+ident)
                            self.status='cancelled'
                            self._wait_cleanup(ident,max_wait=90)
                            break
                        if time.monotonic()>deadline:
                            self.client.call('DELETE','/jobs/'+ident)
                            self.status='timeout';self.last_error='Timeout; sent cooperative cancel'
                            self._wait_cleanup(ident,max_wait=90)
                            break
                        job=self.client.call('GET','/jobs/'+ident)
                        self.latest=latest_timeline(self.folder/'memory_timeline.csv')
                        progress({'generation':index+1,'completed':self.completed,'requested':self.options['count'],
                            'state':job['status'],'stage':job.get('progress',{}).get('stage'),
                            'ram':self.latest.get('process_rss_bytes') if self.latest else None,
                            'vram':self.latest.get('cuda_allocated_bytes') if self.latest else None})
                        if job['status'] in ('COMPLETED','FAILED','CANCELLED'):
                            if job['status']=='COMPLETED':
                                size=self.client.verify_image(ident)
                                self.client.call('POST','/jobs/'+ident+'/ack',{})
                                if not self._wait_cleanup(ident):
                                    self.status='incomplete_profile';self.last_error='Cleanup marker missing from worker report';break
                                self.completed+=1
                                _post_events(self.folder,'generation_completed',generation=index+1,job_id=ident,verified_png_bytes=size)
                            else:
                                self.status='cancelled' if job['status']=='CANCELLED' else 'generation_failed'
                                self.last_error='Worker status: '+job['status']
                                self._wait_cleanup(ident,max_wait=20)
                            break
                        time.sleep(1)
                    if self.status!='running':break
                finally:
                    control.unlink(missing_ok=True)
                    self.active_job=None;self._persist_run_state()
            if self.status=='running':
                self.status='completed' if self.completed==int(self.options['count']) else 'incomplete'
        except BaseException as exc:
            self.status='cancelled' if self.cancelled.is_set() else 'error'
            self.last_error=type(exc).__name__+': '+str(exc)[:300]
            _post_events(self.folder,'run_error',kind=type(exc).__name__)
            if self.active_job:
                try:self.client.call('DELETE','/jobs/'+self.active_job)
                except Exception:pass
        finally:
            self.active_job=None
            _post_events(self.folder,'test_finished',status=self.status,completed=self.completed)
            self._persist_run_state()
            self.drive_zip=build_report(self.folder)
            self.final_zip=Path('/content/YOISAKI_MEMORY_REPORT.zip')
            self.final_zip.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(self.drive_zip,self.final_zip)
            progress({'generation':None,'completed':self.completed,'requested':self.options['count'],
                      'state':self.status,'final_zip':str(self.final_zip),'error':self.last_error})
        return self.final_zip

def _safe_max(records,key):
    values=[r.get('memory',{}).get(key) for r in records]
    values=[v for v in values if isinstance(v,(int,float))]
    return max(values) if values else None

def _summary(stage_rows,state,allocator,timeline_path=None):
    status=state.get('status','unknown');after=[r for r in stage_rows if r.get('stage')=='after_cleanup']
    pre=next((r for r in stage_rows if r.get('stage')=='before_model_load'),None)
    load=next((r for r in stage_rows if r.get('stage')=='after_model_load'),None)
    def val(row,key='process_rss_bytes'):
        return (row or {}).get('memory',{}).get(key)
    peaks_rss=_safe_max(stage_rows,'process_rss_bytes')
    peak_rss_hwm=_safe_max(stage_rows,'process_peak_rss_bytes')
    peaks_gpu=_safe_max(stage_rows,'cuda_peak_allocated_bytes')
    timeline_max_rss=None;timeline_min_available=None;timeline_max_gpu=None
    try:
        with Path(timeline_path).open(newline='',encoding='utf-8') as stream:
            for record in csv.DictReader(stream):
                for name,agg in (('process_rss_bytes','rss'),('system_available_bytes','available'),('cuda_allocated_bytes','gpu')):
                    try:v=int(record[name])
                    except (ValueError,TypeError,KeyError):continue
                    if agg=='rss':timeline_max_rss=v if timeline_max_rss is None else max(timeline_max_rss,v)
                    elif agg=='available':timeline_min_available=v if timeline_min_available is None else min(timeline_min_available,v)
                    else:timeline_max_gpu=v if timeline_max_gpu is None else max(timeline_max_gpu,v)
    except (OSError,TypeError):pass
    maxima=[];by_job={}
    for row in stage_rows:by_job.setdefault(row.get('job_id'),[]).append(row)
    for job_id,rows in by_job.items():
        for a,b in zip(rows,rows[1:]):
            v1,v2=val(a),val(b)
            if v1 is not None and v2 is not None:
                maxima.append((v2-v1,a.get('stage'),b.get('stage')))
    largest=max(maxima,key=lambda x:x[0]) if maxima else None
    prev=None;details=[]
    for i,row in enumerate(after,1):
        curr=val(row);diff=curr-prev if curr is not None and prev is not None else None
        details.append(f'- Генерация {i}, RSS после очистки: **{gib(curr)}**; прирост к предыдущей: **{gib(diff) if diff is not None else "недоступно"}**.')
        details.append(f'  USS: **{gib(val(row, "process_uss_bytes"))}**; PSS: **{gib(val(row, "process_pss_bytes"))}**; доступная RAM: **{gib(val(row, "system_available_bytes"))}**.')
        prev=curr
    allocator_changes=[x.get('rss_difference_bytes') for x in allocator if x.get('performed') and x.get('rss_difference_bytes') is not None]
    states={'completed':'завершена','safety_stop':'ОСТАНОВЛЕНА ПО БЕЗОПАСНОСТИ',
            'cancelled':'ОТМЕНЕНА','error':'ОШИБКА','generation_failed':'ГЕНЕРАЦИЯ ЗАВЕРШИЛАСЬ ОШИБКОЙ',
            'incomplete_profile':'НЕПОЛНЫЙ ПРОФИЛЬ','timeout':'ПРЕВЫШЕН ЛИМИТ ВРЕМЕНИ',
            'stopped_engine_busy':'ДВИЖОК ЗАНЯТ'}
    summary=f'''# YOISAKI MEMORY PROFILER · Отчёт

- Результат диагностики: **{states.get(status,status)}**. Завершено {state.get('completed_generations',0)} из {state.get('requested_generations','?')}.
- Все значения взяты из логов **реального процесса inference**. Отсутствующие измерения отмечены как недоступные.
- Начальный RSS перед загрузкой: **{gib(val(pre))}**.
- RSS после загрузки модели: **{gib(val(load))}**.
- Максимальный RSS на зарегистрированных границах: **{gib(peaks_rss)}**.
- Пиковый RSS по VmHWM процесса (с момента запуска worker): **{gib(peak_rss_hwm)}**.
- Максимальный RSS по регулярным пробам: **{gib(timeline_max_rss)}**.
- Минимально доступная системная RAM по пробам: **{gib(timeline_min_available)}**.
- Максимальная CUDA allocated по регулярным пробам: **{gib(timeline_max_gpu)}**.
- Максимум CUDA allocated (PyTorch peak на зарегистрированных границах): **{gib(peaks_gpu)}**.
- Системная доступная RAM в начале: **{gib(val(pre,'system_available_bytes'))}**.

## Повторные генерации
{chr(10).join(details) if details else 'Достоверных записей after_cleanup нет.'}

## Где наблюдался рост
{('Наибольшее положительное изменение между последовательными точками одного задания: **'+gib(largest[0])+'**, от `'+str(largest[1])+'` до `'+str(largest[2])+'`.') if largest and largest[0]>0 else 'Положительный прирост между достоверными границами не определён.'}
Эти показатели являются **совпадением по времени, а не доказанной причиной**. Фоновая timeline (обычно 1 с) позволяет найти локальный пик, пропущенный снимками границ.

## Эксперимент с allocator
{('Зафиксировано изменение RSS после malloc_trim(0): '+', '.join(gib(v) for v in allocator_changes)+'. Это не является доказательством утечки или её отсутствия.') if allocator_changes else 'Эксперимент отключён, не выполнен или недоступен; доказательств удержания allocator из этого теста нет.'}

## Статус гипотезы об утечке
**Утечка памяти НЕ ПОДТВЕРЖДЕНА.** Рост RSS не доказывает удержание живых объектов. Сравните after_cleanup между одинаковыми генерациями, GC-видимые CPU-тензоры и оценки уникальных storage компонентов с RSS, USS/PSS и возможным эффектом malloc_trim.

## Ограничения и следующий шаг
- Размеры уникальных PyTorch storage компонентов являются **оценками**, не физическим потреблением процессом.
- GC-сканирование покрывает лишь отслеживаемые Python объекты. Не охватывает все C++/torch allocation.
- CUDA-счётчики не синхронизируют GPU и отражают PyTorch allocator, не все внешние потребители VRAM.
- Границу `after_denoising_callback` берём из последнего callback на шаге scheduler; возможны небольшие действия pipeline до VAE.
- Если стадии отсутствуют, установленный Diffusers мог пройти другую ветвь или замер оказался недоступен. Фальшивые точки не создаются.
- Для уверенной идентификации потребуются независимые одинаковые прогоны с надёжными точками after_cleanup, анализ постоянства CPU storage, отдельно помеченные allocator эксперименты и проверка привязки CPU Offload hooks.
- Логи исключают токены, пользовательские prompts, содержимое тензоров и изображения.
'''
    return summary

def build_report(folder,save_to=None):
    """Recoverable even after interrupted inference. Converts incremental raw logs."""
    folder=Path(folder)
    folder.mkdir(parents=True,exist_ok=True)
    state_path=folder/'run_state.json'
    state=json.loads(state_path.read_text()) if state_path.is_file() else {'status':'partial_session_recovered','completed_generations':None,'requested_generations':None}
    stages=jlines(folder/'generation_stages.jsonl')
    components=jlines(folder/'component_samples.jsonl')
    tensors=jlines(folder/'tensor_samples.jsonl')
    allocator=jlines(folder/'allocator_samples.jsonl')
    atomic_json(folder/'component_memory.json',{'samples':components,'status':'measured' if components else 'unavailable',
        'note':'Unique storage bytes are estimates, not physical memory. Cross-component shared storages are counted once per snapshot.'})
    atomic_json(folder/'tensor_analysis.json',{'samples':tensors,'status':'measured' if tensors else 'unavailable',
        'note':'GC-visible CPU tensors only, not every CPU allocation. Scan may be skipped for safety.'})
    atomic_json(folder/'allocator_report.json',{'samples':allocator,'status':'experiment_recorded' if allocator else 'unavailable_or_disabled',
        'note':'malloc_trim is optional, never a permanent fix or proof of causation.'})
    if not (folder/'environment.json').exists():
        atomic_json(folder/'environment.json',{'status':'unavailable','reason':'No worker environment measurement saved before interruption'})
    if not (folder/'generation_stages.jsonl').exists():(folder/'generation_stages.jsonl').write_text('',encoding='utf-8')
    if not (folder/'memory_timeline.csv').exists():
        with (folder/'memory_timeline.csv').open('w',newline='',encoding='utf-8') as f:csv.writer(f).writerow(CSV_FIELDS)
    (folder/'summary_ru.md').write_text(_summary(stages,state,allocator,folder/'memory_timeline.csv'),encoding='utf-8')
    output=Path(save_to) if save_to is not None else folder.parent/(folder.name.removesuffix('.partial')+'.zip')
    output.parent.mkdir(parents=True,exist_ok=True)
    temp=output.with_name(output.name+'.tmp')
    try:
        with zipfile.ZipFile(temp,'w',zipfile.ZIP_DEFLATED) as z:
            for filename in REPORT_FILES:z.write(folder/filename,arcname=filename)
            for extra in ('test_events.jsonl','run_state.json','job_status.jsonl'):
                if (folder/extra).exists():z.write(folder/extra,arcname=extra)
        os.replace(temp,output)
    finally:temp.unlink(missing_ok=True)
    return output

def recover_partial_reports(folder=None):
    """Manual recovery if notebook restarts: ZIP every surviving *.partial folder."""
    base=Path(folder or '/content/drive/MyDrive/YOISAKI_AI_STUDIO/diagnostics/reports')
    if not base.is_dir():return []
    return [str(build_report(p)) for p in sorted(base.glob('*.partial')) if p.is_dir()]
