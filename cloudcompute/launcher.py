"""YOISAKI ENGINE launcher for CloudCompute (deployment edition 1.7.2, engine protocol 1.7.0).

Starts the UNCHANGED engine (engine/worker/serve.py) exactly like the Colab panel does: a fresh
64-hex token in the worker environment only, the server on 127.0.0.1, then a Cloudflare quick tunnel
whose https://*.trycloudflare.com/#token=... link the existing website already accepts.
No port is published and no secret is written to a log.
1.7.2: with YOISAKI_DRIVE_SYNC=1 (default) the same app is started through cloudcompute/serve_cloud.py, which only
adds the authenticated Google Drive sync routes (/sync/*); the engine code itself is not modified.

Stdlib only: the same file serves the Docker HEALTHCHECK and the check/stop scripts.
Subcommands: run (default), healthcheck, link, status.
"""
import fcntl
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
VERSION = (Path(__file__).with_name('VERSION').read_text().strip() if Path(__file__).with_name('VERSION').is_file() else 'unknown')
TUNNEL_RE = re.compile(r'https://[a-z0-9-]+\.trycloudflare\.com')
# Writable subfolders of the data root. models/ is only read by the engine.
WRITABLE = ('huggingface-cache', 'outputs', 'logs', 'diagnostics', 'runtime/state', 'runtime/home', 'runtime/sync')
MODEL_FOLDERS = ('checkpoints', 'loras', 'vae', 'controlnet')


class LaunchError(RuntimeError):
    pass


class Config:
    def __init__(self, environ=None):
        e = os.environ if environ is None else environ
        root = e.get('YOISAKI_DATA_ROOT', '').strip()
        if not root:
            raise LaunchError('YOISAKI_DATA_ROOT не задан. Укажите папку на постоянном диске, например /workspace/yoisaki-data.')
        self.data = Path(root).expanduser()
        if not self.data.is_absolute():
            raise LaunchError('YOISAKI_DATA_ROOT должен быть абсолютным путём.')
        self.engine = Path(e.get('YOISAKI_ENGINE_DIR') or APP / 'engine').resolve()
        self.python = e.get('YOISAKI_PYTHON') or sys.executable
        port = e.get('YOISAKI_PORT', '8765')
        if not port.isdigit() or not 1024 <= int(port) <= 65535:
            raise LaunchError('YOISAKI_PORT должен быть числом 1024–65535.')
        self.port = int(port)
        self.tunnel = e.get('YOISAKI_TUNNEL', '1') != '0'
        self.cloudflared = e.get('YOISAKI_CLOUDFLARED') or shutil.which('cloudflared') or str(self.data / 'runtime/bin/cloudflared')
        self.gpu_preflight = e.get('YOISAKI_GPU_PREFLIGHT', '1') != '0'
        self.warmup = e.get('YOISAKI_WARMUP_CHECKPOINT', '').strip()
        self.server_timeout = float(e.get('YOISAKI_SERVER_TIMEOUT', '180'))
        self.tunnel_timeout = float(e.get('YOISAKI_TUNNEL_TIMEOUT', '90'))
        self.tunnel_restarts = int(e.get('YOISAKI_TUNNEL_RESTARTS', '3'))
        self.drive_sync = e.get('YOISAKI_DRIVE_SYNC', '1') != '0'
        self.models = self.data / 'models'
        self.state = self.data / 'runtime/state'
        self.logs = self.data / 'logs'
        self.diagnostics = self.data / 'diagnostics'

    @property
    def local(self):
        return f'http://127.0.0.1:{self.port}'


def prepare(cfg):
    """Create only missing folders; never rewrite or delete user files."""
    if not cfg.engine.joinpath('worker/serve.py').is_file():
        raise LaunchError(f'Не найден движок: {cfg.engine}/worker/serve.py')
    for sub in MODEL_FOLDERS:
        (cfg.models / sub).mkdir(parents=True, exist_ok=True)
    for sub in WRITABLE:
        (cfg.data / sub).mkdir(parents=True, exist_ok=True)
    os.chmod(cfg.state, 0o700)
    os.chmod(cfg.data / 'runtime/sync', 0o700)
    marker = cfg.data / '.yoisaki-data-id'
    if not marker.exists():
        # Persistence probe: if this date survives an instance stop/start, the disk is persistent.
        try:
            with open(marker, 'x') as f:
                f.write(json.dumps({'id': uuid.uuid4().hex, 'created_unix': int(time.time())}) + '\n')
        except OSError:
            pass  # exists, or the data root is not writable for this user (start script creates it)


def child_env(cfg, token):
    sys.path.insert(0, str(cfg.engine))
    try:
        from worker.allocator_policy import worker_environment  # same allocator policy as Colab
    finally:
        sys.path.remove(str(cfg.engine))
    env = worker_environment(os.environ)
    env.update(YOISAKI_TOKEN=token, YOISAKI_MODEL_ROOT=str(cfg.models), YOISAKI_RESULTS_DIR=str(cfg.data / 'outputs'),
               YOISAKI_PORT=str(cfg.port), PYTHONPATH=str(cfg.engine), PYTHONUNBUFFERED='1')
    env.setdefault('HF_HOME', str(cfg.data / 'huggingface-cache'))
    env.setdefault('TORCH_HOME', str(Path(env['HF_HOME']) / 'torch'))
    env.setdefault('XDG_CACHE_HOME', str(cfg.data / 'runtime/home/.cache'))
    env.setdefault('MPLCONFIGDIR', str(cfg.data / 'runtime/home/.matplotlib'))
    if os.environ.get('YOISAKI_HF_OFFLINE', '0') == '1':
        env['HF_HUB_OFFLINE'] = '1'
    # SDPose-OOD: a local diffusers-layout mirror is used when present (engine already supports it).
    if 'YOISAKI_SDPOSE_REPO' not in env and (cfg.data / 'sdpose/unet').is_dir():
        env['YOISAKI_SDPOSE_REPO'] = str(cfg.data / 'sdpose')
    return env


def rotate(path):
    if path.exists() and path.stat().st_size:
        os.replace(path, path.with_name(path.name + '.1'))
    return path.open('w')


def write_private(path, text):
    temp = path.with_name(path.name + '.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(text)
    os.replace(temp, path)


def request_json(url, token, method='GET', body=None, timeout=8):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={'Authorization': 'Bearer ' + token, **({'Content-Type': 'application/json'} if data else {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def verify_tunnel(base, token):
    return request_json(base + '/health', token, timeout=5).get('engine') == 'YOISAKI_ENGINE'


def process_start_unix(pid):
    """Kernel start time of a process (used for PID 1 = container start inside the image)."""
    try:
        ticks = int(Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19])
        boot = next(int(line.split()[1]) for line in Path('/proc/stat').read_text().splitlines() if line.startswith('btime '))
        return boot + ticks / os.sysconf('SC_CLK_TCK')
    except (OSError, ValueError, IndexError, StopIteration):
        return None


def log(msg):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), msg, flush=True)


class Launcher:
    def __init__(self, cfg):
        self.cfg = cfg
        self.server = self.tunnel = None
        self.token = ''
        self.url = ''
        self.handles = []
        self.lock = None
        self.stopping = False
        self.timings = {'run_id': uuid.uuid4().hex[:12], 'deploy_version': VERSION, 'launcher_start_unix': time.time()}
        if os.environ.get('YOISAKI_IN_IMAGE') == '1':
            self.timings['container_start_unix'] = process_start_unix(1)

    # -- state -------------------------------------------------------------------------------
    def acquire(self):
        self.lock = open(self.cfg.state / 'launcher.lock', 'a')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise LaunchError('YOISAKI ENGINE уже запущен с этой папкой данных. Сначала выполните ./stop-cloudcompute.sh.')

    def save_state(self, phase, **extra):
        children = [p.pid for p in (self.server, self.tunnel) if p is not None and p.poll() is None]
        state = {'pid': os.getpid(), 'phase': phase, 'port': self.cfg.port, 'deploy_version': VERSION,
                 'public_origin': self.url or None, 'children': children, 'updated_unix': time.time(),
                 # PIDs are only meaningful in the PID namespace that wrote them (container vs host).
                 'in_image': os.environ.get('YOISAKI_IN_IMAGE') == '1', **extra}
        write_private(self.cfg.state / 'launcher.json', json.dumps(state) + '\n')

    def mark(self, name):
        self.timings[name] = time.time()

    def save_timings(self):
        t = self.timings
        start = t.get('container_start_unix') or t['launcher_start_unix']
        row = dict(t)
        for key in ('gpu_check_done_unix', 'server_ready_unix', 'warmup_done_unix', 'tunnel_ready_unix'):
            if key in t:
                row[key.replace('_unix', '_after_s')] = round(t[key] - start, 1)
        try:
            with (self.cfg.diagnostics / 'startup-timings.jsonl').open('a') as f:
                f.write(json.dumps(row, separators=(',', ':')) + '\n')
        except OSError:
            pass
        return row

    # -- steps -------------------------------------------------------------------------------
    def gpu_check(self):
        if not self.cfg.gpu_preflight:
            log('Проверка GPU пропущена (YOISAKI_GPU_PREFLIGHT=0).')
            return
        log('Проверка GPU и совместимости PyTorch/CUDA…')
        result = subprocess.run([self.cfg.python, str(Path(__file__).with_name('diagnose.py')), '--gpu-check'],
                                capture_output=True, text=True, timeout=300)
        sys.stdout.write(result.stdout)
        if result.returncode:
            sys.stdout.write(result.stderr[-4000:])
            raise LaunchError('GPU не прошёл проверку. Движок не запущен, чтобы не тратить оплачиваемое время. Подробности выше.')
        self.mark('gpu_check_done_unix')

    def start_server(self):
        self.token = secrets.token_hex(32)
        f = rotate(self.cfg.logs / 'server.log')
        self.handles.append(f)
        # Same engine app either way; serve_cloud.py only adds the authenticated /sync/* routes.
        command = [self.cfg.python, str(Path(__file__).with_name('serve_cloud.py'))] if self.cfg.drive_sync else [self.cfg.python, '-m', 'worker.serve']
        self.server = subprocess.Popen(command, cwd=self.cfg.engine,
                                       env=child_env(self.cfg, self.token), stdout=f, stderr=subprocess.STDOUT,
                                       stdin=subprocess.DEVNULL, start_new_session=True)
        # The token file lets the healthcheck/check scripts query the local server; 0600 in a 0700 folder.
        write_private(self.cfg.state / 'token', self.token + '\n')
        deadline = time.monotonic() + self.cfg.server_timeout
        last = None
        while time.monotonic() < deadline and not self.stopping:
            if self.server.poll() is not None:
                raise LaunchError('Сервер движка завершился при запуске. См. ./check-cloudcompute.sh logs')
            try:
                last = request_json(self.cfg.local + '/health', self.token, timeout=3)
                if last.get('state') == 'READY':
                    self.mark('server_ready_unix')
                    log(f"Сервер готов: YOISAKI ENGINE v{last.get('engine_version')} · GPU {last.get('gpu_name')} · VRAM {last.get('vram_available_mb')}/{last.get('vram_total_mb')} МБ")
                    return last
            except (OSError, ValueError):
                pass
            time.sleep(1)
        if last and last.get('state') == 'ERROR':
            raise LaunchError('Сервер отвечает, но CUDA недоступна (state=ERROR). Проверьте GPU: ./check-cloudcompute.sh')
        raise LaunchError(f'Сервер не ответил за {int(self.cfg.server_timeout)} с.')

    def report_models(self):
        try:
            models = request_json(self.cfg.local + '/models', self.token, timeout=60)['models']
        except (OSError, ValueError, KeyError):
            return
        count = lambda kind: sum(m['kind'] == kind and m.get('compatible') is not False for m in models)
        log(f"Модели: checkpoints {count('checkpoint')} · LoRA {count('lora')} · VAE {count('vae')} ({self.cfg.models})")
        if not count('checkpoint'):
            log('ВНИМАНИЕ: нет совместимого SDXL checkpoint. Синхронизируйте Google Drive (сайт → Модели → GOOGLE DRIVE AUTO SYNC '
                'или ./drive-sync-cloudcompute.sh sync) либо ./fetch-models-cloudcompute.sh (движок продолжит работу).')

    def warmup(self):
        """Optional: one tiny real generation so the checkpoint is loaded before the link is shown."""
        name = self.cfg.warmup
        if not name:
            return
        models = request_json(self.cfg.local + '/models', self.token, timeout=60)['models']
        match = [m for m in models if m['kind'] == 'checkpoint' and m['name'] == name and m.get('compatible') is not False]
        if not match:
            log(f'Прогрев пропущен: checkpoint «{name}» не найден в models/checkpoints.')
            return
        log(f'Прогрев: загрузка «{name}» и пробная генерация 512×512, 2 шага…')
        started = time.time()
        body = dict(client_request_id=str(uuid.uuid4()), mode='text2img', kind='text2img', prompt='warmup', negative_prompt='',
                    checkpoint_id=match[0]['id'], vae_id='auto', lora_adapters=[], width=512, height=512, steps=2,
                    cfg_scale=5, sampler='Euler', scheduler='Normal', seed=1, batch_size=1)
        job = request_json(self.cfg.local + '/generate', self.token, 'POST', body, timeout=60)['id']
        while not self.stopping:
            status = request_json(self.cfg.local + '/jobs/' + job, self.token, timeout=30)
            if status['status'] == 'COMPLETED':
                request_json(self.cfg.local + f'/jobs/{job}/ack', self.token, 'POST', None, timeout=30)
                self.mark('warmup_done_unix')
                self.timings['warmup_seconds'] = round(time.time() - started, 1)
                log(f"Прогрев завершён за {self.timings['warmup_seconds']} с: модель в памяти, генерация работает.")
                return
            if status['status'] in ('FAILED', 'CANCELLED'):
                log('Прогрев не удался: ' + str(status.get('error', status['status'])) + ' Движок продолжит работу.')
                return
            time.sleep(2)

    def start_tunnel(self):
        if not self.cfg.tunnel:
            log('Туннель отключён (YOISAKI_TUNNEL=0): движок доступен только локально на сервере.')
            return
        binary = self.cfg.cloudflared
        if not Path(binary).is_file() or not os.access(binary, os.X_OK):
            raise LaunchError('cloudflared не найден. Повторите ./start-cloudcompute.sh (он установит закреплённую версию).')
        path = self.cfg.logs / 'tunnel.log'
        f = rotate(path)
        self.handles.append(f)
        self.tunnel = subprocess.Popen([binary, 'tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', self.cfg.local],
                                       stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
        deadline = time.monotonic() + self.cfg.tunnel_timeout
        while time.monotonic() < deadline and not self.stopping:
            if self.tunnel.poll() is not None:
                raise LaunchError('Туннель Cloudflare завершился. См. ./check-cloudcompute.sh logs')
            match = TUNNEL_RE.search(path.read_text(errors='replace'))
            if match:
                try:
                    if verify_tunnel(match.group(0), self.token):
                        self.url = match.group(0)
                        write_private(self.cfg.state / 'link.txt', self.url + '/#token=' + self.token + '\n')
                        self.mark('tunnel_ready_unix')
                        log('Туннель проверен: ' + self.url + ' (полная ссылка с токеном: ./check-cloudcompute.sh link)')
                        return
                except (OSError, ValueError):
                    pass
            time.sleep(1)
        raise LaunchError('Cloudflare не подтвердил соединение. Повторите запуск через минуту.')

    def stop_tunnel(self):
        self.url = ''
        (self.cfg.state / 'link.txt').unlink(missing_ok=True)
        terminate(self.tunnel, 10)
        self.tunnel = None

    def shutdown(self):
        """Tunnel first (no new requests), then the server (uvicorn lifespan cancels queued jobs)."""
        self.stop_tunnel()
        terminate(self.server, float(os.environ.get('YOISAKI_STOP_TIMEOUT', '30')))
        self.server = None
        for f in self.handles:
            f.close()
        self.handles = []
        for name in ('token', 'link.txt'):
            (self.cfg.state / name).unlink(missing_ok=True)
        self.token = ''

    # -- main --------------------------------------------------------------------------------
    def run(self):
        prepare(self.cfg)
        self.acquire()
        try:
            self.save_state('STARTING')
            self.gpu_check()
            self.start_server()
            self.report_models()
            self.save_state('WARMUP' if self.cfg.warmup else 'TUNNEL')
            self.warmup()
            self.start_tunnel()
            row = self.save_timings()
            self.save_state('READY', timings=row)
            log('YOISAKI ENGINE готов. Модель SDXL загружается при первой генерации (если не включён прогрев).')
            self.supervise()
            return 0
        finally:
            self.save_state('STOPPING')
            self.shutdown()
            self.save_state('STOPPED')

    def supervise(self):
        failures = restarts = ticks = 0
        while not self.stopping:
            time.sleep(1)
            ticks += 1
            if self.server.poll() is not None:
                raise LaunchError(f'Сервер движка завершился (код {self.server.returncode}). См. ./check-cloudcompute.sh logs')
            if not self.cfg.tunnel or ticks % 5:
                continue
            lost = self.tunnel.poll() is not None
            if not lost and ticks % 30 == 0:
                try:
                    failures = 0 if verify_tunnel(self.url, self.token) else failures + 1
                except (OSError, ValueError):
                    failures += 1
                lost = failures >= 3
            if lost:
                if restarts >= self.cfg.tunnel_restarts:
                    raise LaunchError('Туннель Cloudflare потерян несколько раз подряд. Движок остановлен.')
                restarts += 1
                failures = 0
                log(f'Туннель потерян, создаю новый ({restarts}/{self.cfg.tunnel_restarts}). Ссылка изменится — вставьте новую на сайте.')
                self.stop_tunnel()
                self.start_tunnel()
                self.save_state('READY', tunnel_restarts=restarts)


def terminate(process, timeout):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def read_private(cfg, name):
    try:
        return (cfg.state / name).read_text().strip()
    except OSError:
        return ''


def local_status(cfg):
    """Live engine state for the check script. Never returns the token."""
    out = {'launcher': None, 'health': None, 'model_loaded': None, 'link_ready': bool(read_private(cfg, 'link.txt'))}
    try:
        out['launcher'] = json.loads((cfg.state / 'launcher.json').read_text())
    except (OSError, ValueError):
        pass
    token = read_private(cfg, 'token')
    if token:
        try:
            out['health'] = request_json(cfg.local + '/health', token, timeout=5)
            last = request_json(cfg.local + '/memory', token, timeout=5).get('last') or {}
            out['model_loaded'] = bool(last.get('pipeline_loaded'))
        except (OSError, ValueError):
            pass
    return out


def main(argv):
    command = argv[1] if len(argv) > 1 else 'run'
    try:
        cfg = Config()
        if command == 'healthcheck':
            token = read_private(cfg, 'token')
            state = request_json(cfg.local + '/health', token, timeout=8).get('state') if token else None
            return 0 if state in ('READY', 'BUSY') else 1
        if command == 'link':
            link = read_private(cfg, 'link.txt')
            if not link:
                print('Ссылки нет: движок не запущен или туннель ещё не готов.', file=sys.stderr)
                return 1
            print(link)
            return 0
        if command == 'status':
            print(json.dumps(local_status(cfg), ensure_ascii=False))
            return 0
        if command != 'run':
            print('Использование: launcher.py [run|healthcheck|link|status]', file=sys.stderr)
            return 2
        launcher = Launcher(cfg)

        def stop(_signum, _frame):
            if launcher.stopping:
                return  # a second signal must not interrupt the cleanup already running
            launcher.stopping = True
            raise SystemExit(0)
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, stop)
        log(f'YOISAKI ENGINE · CloudCompute deployment {VERSION} · данные: {cfg.data}')
        return launcher.run()
    except LaunchError as exc:
        log('ОШИБКА: ' + str(exc))
        return 3
    except (urllib.error.URLError, OSError) as exc:
        if command == 'healthcheck':
            return 1
        log(f'ОШИБКА: {type(exc).__name__}: {exc}')
        return 3


if __name__ == '__main__':
    os.umask(0o022)  # `docker exec` may start with umask 000: never create world-writable files
    sys.exit(main(sys.argv))
