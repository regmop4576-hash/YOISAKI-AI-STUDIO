"""Compact, mobile-friendly notebook widgets. Existing YOISAKI panel untouched."""
from __future__ import annotations
import html
import threading
from IPython.display import display
from pathlib import Path
import ipywidgets as w
from .runner import DiagnosticRunner,build_report,gib,recover_partial_reports

class NotebookDiagnostics:
    def __init__(self,panel):
        self.panel=panel;self.worker=None;self.runner=None
        checkpoints=[(x['name']+' · '+x['id'][:8],x['id']) for x in getattr(panel,'models',[])
                     if x.get('kind')=='checkpoint' and x.get('compatible') is not False]
        self.checkpoint=w.Dropdown(options=checkpoints,description='Checkpoint',
            style={'description_width':'105px'},layout=w.Layout(width='100%'))
        self.count=w.BoundedIntText(value=2,min=1,max=10,description='Генераций',style={'description_width':'105px'},layout=w.Layout(width='100%'))
        self.resolution=w.Dropdown(options=[('512 × 512',512),('768 × 768',768),('1024 × 1024',1024)],value=768,
             description='Размер',style={'description_width':'105px'},layout=w.Layout(width='100%'))
        self.steps=w.BoundedIntText(value=20,min=1,max=60,description='Steps',style={'description_width':'105px'},layout=w.Layout(width='100%'))
        self.cfg=w.BoundedFloatText(value=5,min=1,max=20,step=.5,description='CFG',style={'description_width':'105px'},layout=w.Layout(width='100%'))
        self.seed=w.BoundedIntText(value=123,min=0,max=2147483647,description='Seed',style={'description_width':'105px'},layout=w.Layout(width='100%'))
        self.interval=w.BoundedFloatText(value=1.,min=.25,max=10.,step=.25,description='Интервал, c',style={'description_width':'105px'},layout=w.Layout(width='100%'))
        self.tensors=w.Checkbox(value=False,description='Подробный снимок CPU-тензоров')
        self.allocator=w.Checkbox(value=False,description='Эксперимент malloc_trim после очистки')
        self.min_ram=w.BoundedFloatText(value=2.5,min=.5,max=15,step=.5,description='RAM min GiB',style={'description_width':'105px'},layout=w.Layout(width='100%'))
        self.max_rss=w.BoundedFloatText(value=10.3,min=2,max=30,step=.5,description='RSS max GiB',style={'description_width':'105px'},layout=w.Layout(width='100%'))
        self.advanced=w.Accordion(children=[w.VBox([self.interval,self.tensors,self.allocator,self.min_ram,self.max_rss])],selected_index=None)
        self.advanced.set_title(0,'⚙ Дополнительные параметры и пороги RAM')
        self.status=w.HTML(value='<div style="color:#ffc66b">Готово к диагностике. Генерации выполняются через настоящий движок v1.7.0.</div>')
        self.start_button=w.Button(description='🔬 ЗАПУСТИТЬ ДИАГНОСТИКУ',button_style='warning',layout=w.Layout(width='100%',height='48px'))
        self.stop_button=w.Button(description='🛑 Остановить тест',button_style='',disabled=True,layout=w.Layout(width='100%',height='40px'))
        self.download_button=w.Button(description='📥 СКАЧАТЬ ОТЧЁТ',disabled=True,layout=w.Layout(width='100%',height='42px'))
        self.start_button.on_click(self.start)
        self.stop_button.on_click(self.stop)
        self.download_button.on_click(self.download)
        head=w.HTML('<div style="background:#17191e;color:#ffc66b;padding:12px;border-radius:12px;border:1px solid #9b6425"><b>🔬 YOISAKI MEMORY PROFILER v1.0</b><br><small>Два реальных прогона · без LoRA · Regional OFF · batch 1</small></div>')
        self.widget=w.VBox([head,self.checkpoint,self.count,self.resolution,self.steps,self.cfg,self.seed,
            self.advanced,self.start_button,self.stop_button,self.download_button,self.status],
            layout=w.Layout(width='100%',max_width='620px'))
    def show(self):display(self.widget)
    def start(self,_=None):
        if self.worker and self.worker.is_alive():return
        if not getattr(self.panel.controller,'server',None) or self.panel.controller.server.poll() is not None:
            self.status.value='⚠ Сначала запустите GPU-движок кнопкой выше.';return
        if self.checkpoint.value is None:
            self.status.value='⚠ Не найден checkpoint; обновите модели в основной панели.';return
        try:
            self.runner=DiagnosticRunner(self.panel.controller.token,self.checkpoint.value,
                count=int(self.count.value),width=int(self.resolution.value),height=int(self.resolution.value),
                steps=int(self.steps.value),cfg=float(self.cfg.value),seed=int(self.seed.value),
                sampling_interval=float(self.interval.value),detailed_tensors=bool(self.tensors.value),
                allocator_test=bool(self.allocator.value),min_available_gib=float(self.min_ram.value),
                max_process_rss_gib=float(self.max_rss.value))
        except Exception as e:
            self.status.value='<b>⚠ '+html.escape(str(e))+'</b>';return
        self.start_button.disabled=True;self.download_button.disabled=True;self.stop_button.disabled=False
        self.status.value='<b>🔬 Запущено.</b> Отчёт сохраняется инкрементально в Google Drive.'
        def run():
            try:self.runner.run(progress=self.progress)
            except Exception as exc:
                self.status.value='⚠ Ошибка интерфейса: '+html.escape(type(exc).__name__)
            finally:
                self.start_button.disabled=False;self.stop_button.disabled=True
                self.download_button.disabled=not bool(self.runner and self.runner.final_zip and self.runner.final_zip.exists())
        self.worker=threading.Thread(target=run,daemon=True,name='yoisaki-diagnostic-ui')
        self.worker.start()
    def progress(self,data):
        finished=data.get('final_zip')
        ram, vram=gib(data.get('ram')),gib(data.get('vram'))
        prefix=f'Готово: {data.get("completed",0)} / {data.get("requested",0)}'
        if finished:
            result='✅ Завершено' if data['state']=='completed' else '⚠ '+html.escape(str(data['state']))
            reason=html.escape(str(data.get('error') or ''))
            self.status.value=f'<div style="background:#202228;color:#f4f0e6;padding:12px;border-radius:10px">{result}. {prefix}<br>{reason}<br>📁 Архив сохранён в Drive. Нажмите скачать.</div>'
            self.download_button.disabled=False
        else:
            self.status.value=(f'<div style="background:#202228;color:#f4f0e6;padding:12px;border-radius:10px">'
                f'🔬 {prefix}<br>Прогон: {data.get("generation")} · '
                f'{html.escape(str(data.get("stage") or data.get("state")))}<br>RAM процесса: {ram} · CUDA allocated: {vram}</div>')
    def stop(self,_=None):
        if self.runner:self.runner.cancel();self.status.value='⏹ Запрошена безопасная отмена. Текущий шаг завершится перед остановкой.'
    def download(self,_=None):
        path=self.runner.final_zip if self.runner else None
        if not path or not Path(path).exists():
            self.status.value='⚠ ZIP отсутствует. Частичные логи можно восстановить через recover_partial_reports().';return
        try:
            from google.colab import files
            files.download(str(path))
        except Exception as exc:self.status.value='⚠ Не удалось инициировать скачивание: '+html.escape(type(exc).__name__)
