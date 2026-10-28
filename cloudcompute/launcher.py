"""YOISAKI ENGINE launcher for CloudCompute (deployment edition 1.7.2, engine protocol 1.7.0).

Starts the UNCHANGED engine (engine/worker/serve.py) exactly like the Colab panel does: a fresh
64-hex token in the worker environment only, the server on 127.0.0.1, then a Cloudflare quick tunnel
whose https://*.trycloudflare.com/#token=... link the existing website already accepts.
No port is published and no secret is written to a log.
1.7.2: with YOISAKI_DRIVE_SYNC=1 (default) the same app is started through cloudcompute/serve_cloud.py, which only
adds the authenticated Google Drive sync routes (/sync/*); the engine code itself is not modified.

Stdlib only: the same file serves the Docker HEALTHCHECK and the check/stop scripts.
Subcommands: run (default), healthcheck, link, status, rotate-token.

1.7.3 (one-click connection, all optional and backward compatible):
  - persistent engine token: config/engine/engine.token (0600) survives restarts, so a remembered connection on the
    website keeps working; `launcher.py rotate-token` revokes it (YOISAKI_STABLE_LINK=0 = old behaviour);
  - YOISAKI_TUNNEL_MODE=named: a Cloudflare Named Tunnel with a fixed hostname (YOISAKI_PUBLIC_HOSTNAME, token in
    config/engine/cloudflared.token) instead of a new *.trycloudflare.com name on every start;
  - a tunnel failure no longer stops the engine: the tunnel is retried with growing pauses (phase TUNNEL_RETRY);
  - YOISAKI_RENDEZVOUS=ntfy: the verified Quick Tunnel address is published signed (cloudcompute/rendezvous.py).

1.7.5 (automatic initialization): with YOISAKI_RENDEZVOUS=ntfy and a persistent token the launcher also publishes
signed initialization stages (ENGINE_STARTING, SERVER_READY, TUNNEL_RETRY, GPU_CHECK_FAILED, ENGINE_FAILED), so the
website reports what the GPU really did instead of guessing. Best effort in a background thread; never fatal.
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
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
VERSION = (Path(__file__).with_name('VERSION').read_text().strip() if Path(__file__).with_name('VERSION').is_file() else 'unknown')
TUNNEL_RE = re.compile(r'https://[a-z0-9-]+\.trycloudflare\.com')
HOSTNAME_RE = re.compile(r'^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')
TOKEN_RE = re.compile(r'^[a-f0-9]{64}$')
RETRY_PAUSES = (15, 30, 60, 120, 300)  # seconds between tunnel attempts once the quick restarts are used up
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
        # Off by default (each start = new token, as before); ./setup-cloudcompute.sh turns it on with the user's consent.
        self.persistent_token = e.get('YOISAKI_STABLE_LINK', '0') == '1'
        self.tunnel_mode = e.get('YOISAKI_TUNNEL_MODE', 'quick').strip().lower() or 'quick'
        if self.tunnel_mode not in ('quick', 'named'):
            raise LaunchError('YOISAKI_TUNNEL_MODE должен быть quick или named.')
        self.public_hostname = e.get('YOISAKI_PUBLIC_HOSTNAME', '').strip().lower().rstrip('.')
        if self.tunnel and self.tunnel_mode == 'named' and not HOSTNAME_RE.match(self.public_hostname):
            raise LaunchError('Для YOISAKI_TUNNEL_MODE=named укажите YOISAKI_PUBLIC_HOSTNAME, например gpu.example.com.')
        self.tunnel_dns_delay = float(e.get('YOISAKI_TUNNEL_DNS_DELAY', '5'))
        self.rendezvous = e.get('YOISAKI_RENDEZVOUS', 'off').strip().lower() == 'ntfy'
        self.rendezvous_host = e.get('YOISAKI_RENDEZVOUS_HOST', 'ntfy.sh').strip().lower()
        self.models = self.data / 'models'
        self.state = self.data / 'runtime/state'
        self.logs = self.data / 'logs'
        self.diagnostics = self.data / 'diagnostics'
        self.secrets = self.data / 'config/engine'

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
    try:  # created and granted by lib.sh when the start script runs as root; created here otherwise
        cfg.secrets.mkdir(parents=True, exist_ok=True)
        if cfg.secrets.stat().st_uid == os.getuid():
            os.chmod(cfg.secrets, 0o700)
    except OSError:
        pass
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


def engine_token(cfg):
    """1.7.3: with YOISAKI_STABLE_LINK=1 the token stays the same across restarts until rotated; otherwise new every start."""
    if not cfg.persistent_token:
        return secrets.token_hex(32)
    path = cfg.secrets / 'engine.token'
    try:
        value = path.read_text().strip()
    except OSError:
        value = ''
    if TOKEN_RE.match(value):
        return value
    value = secrets.token_hex(32)
    try:
        write_private(path, value + '\n')
    except OSError as exc:
        log(f'ВНИМАНИЕ: постоянный токен не сохранён ({type(exc).__name__}); после перезапуска понадобится новая ссылка.')
    return value


def rotate_token(cfg):
    """Revokes the remembered connection of every website: the next engine start uses a new token."""
    path = cfg.secrets / 'engine.token'
    cfg.secrets.mkdir(parents=True, exist_ok=True)
    write_private(path, secrets.token_hex(32) + '\n')
    if os.getuid() == 0:  # run by root for an engine that runs as its own user: keep the folder owner's access
        folder = cfg.secrets.stat()
        os.chown(path, folder.st_uid, folder.st_gid)
    return path


def tunnel_token(cfg):
    try:
        value = (cfg.secrets / 'cloudflared.token').read_text().strip()
    except OSError:
        return ''
    return value if re.fullmatch(r'[A-Za-z0-9+/=_.-]{40,4096}', value) else ''


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
        self.failure_signalled = False
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
                 'public_origin': self.url or None, 'children': children, 'updated_unix': time.time(), 'last_startup_error': getattr(self, 'last_startup_error', None),
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
            self.failure_signalled = True
            sent = self.signal('GPU_CHECK_FAILED')
            if sent:
                sent.join(12)  # the process exits right after: give the failure report a chance to leave
            raise LaunchError('GPU не прошёл проверку. Движок не запущен, чтобы не тратить оплачиваемое время. Подробности выше.')
        self.mark('gpu_check_done_unix')

    def start_server(self):
        self.token = engine_token(self.cfg)
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
        named = self.cfg.tunnel_mode == 'named'
        env = None
        if named:
            secret = tunnel_token(self.cfg)
            if not secret:
                raise LaunchError('Нет токена Named Tunnel: сохраните его в config/engine/cloudflared.token (./setup-cloudcompute.sh).')
            # The tunnel token goes through the environment (TUNNEL_TOKEN), never through argv or a log.
            env = {**os.environ, 'TUNNEL_TOKEN': secret}
            command = [binary, 'tunnel', '--no-autoupdate', '--protocol', 'http2', 'run']
        else:
            command = [binary, 'tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', self.cfg.local]
        self.tunnel = subprocess.Popen(command, stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                       start_new_session=True, env=env)
        deadline = time.monotonic() + self.cfg.tunnel_timeout
        found_at = None
        while time.monotonic() < deadline and not self.stopping:
            if self.tunnel.poll() is not None:
                raise LaunchError('Туннель Cloudflare завершился. См. ./check-cloudcompute.sh logs')
            if named:
                candidate = 'https://' + self.cfg.public_hostname
            else:
                match = TUNNEL_RE.search(path.read_text(errors='replace'))
                candidate = match.group(0) if match else None
            if candidate:
                found_at = found_at or time.monotonic()
                # 1.7.3: do not query a brand-new quick-tunnel name immediately. An early lookup can be answered
                # NXDOMAIN and cached by the resolver (suspected cause of "Could not resolve host"; unconfirmed).
                if named or time.monotonic() - found_at >= self.cfg.tunnel_dns_delay:
                    try:
                        if verify_tunnel(candidate, self.token):
                            self.url = candidate
                            write_private(self.cfg.state / 'link.txt', self.url + '/#token=' + self.token + '\n')
                            self.mark('tunnel_ready_unix')
                            log('Туннель проверен: ' + self.url + ' (полная ссылка с токеном: ./check-cloudcompute.sh link)')
                            self.announce()
                            return
                    except (OSError, ValueError):
                        pass
            time.sleep(1)
        if named:
            raise LaunchError(f'Адрес {self.cfg.public_hostname} не отвечает движком. Проверьте в Cloudflare: Public Hostname → '
                              f'Service http://127.0.0.1:{self.cfg.port} и что DNS-запись создана.')
        raise LaunchError('Cloudflare не подтвердил соединение. Повторю попытку автоматически.')

    def signal(self, stage):
        """1.7.5: publish a signed initialization stage (same opt-in as announce(); the token itself is never sent)."""
        if not self.cfg.rendezvous or not self.cfg.persistent_token:
            return None
        token = self.token or engine_token(self.cfg)

        def send():
            try:
                from rendezvous import publish_status
                publish_status(token, stage, host=self.cfg.rendezvous_host)
            except Exception as exc:  # optional signal: the engine keeps running
                log(f'Этап {stage} не опубликован: {type(exc).__name__}.')
        worker = threading.Thread(target=send, name='yoisaki-stage', daemon=True)
        worker.start()
        return worker

    def announce(self):
        """YOISAKI_RENDEZVOUS=ntfy: publish the verified quick-tunnel address, signed with the engine token."""
        if not self.cfg.rendezvous or self.cfg.tunnel_mode == 'named':
            return
        if not self.cfg.persistent_token:
            log('Автообнаружение адреса пропущено: оно работает только с постоянным токеном (YOISAKI_STABLE_LINK=1).')
            return
        try:
            from rendezvous import publish
            publish(self.token, self.url, host=self.cfg.rendezvous_host)
            log(f'Адрес опубликован для автообнаружения ({self.cfg.rendezvous_host}, подписан токеном движка).')
        except Exception as exc:  # optional feature: the engine keeps running
            log(f'Адрес не опубликован для автообнаружения: {type(exc).__name__}. Сайт можно подключить ссылкой.')

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
            self.signal('ENGINE_STARTING')
            self.gpu_check()
            self.start_server()
            self.signal('SERVER_READY')
            self.report_models()
            self.save_state('WARMUP' if self.cfg.warmup else 'TUNNEL')
            self.warmup()
            try:
                self.start_tunnel()
            except LaunchError as exc:
                # 1.7.3: the engine stays up; supervise() keeps retrying the tunnel.
                log('Туннель пока не готов: ' + str(exc))
                self.stop_tunnel()
            row = self.save_timings()
            if self.url or not self.cfg.tunnel:
                self.save_state('READY', timings=row)
                log('YOISAKI ENGINE готов. Модель SDXL загружается при первой генерации (если не включён прогрев).')
            else:
                self.save_state('TUNNEL_RETRY', timings=row)
                self.signal('TUNNEL_RETRY')
                log('Движок работает, туннель переподключается автоматически.')
            self.supervise()
            return 0
        except LaunchError as exc:
            self.last_startup_error = str(exc)[:400]
            if not self.failure_signalled and not self.stopping:
                sent = self.signal('ENGINE_FAILED')
                if sent:
                    sent.join(12)
            raise
        finally:
            self.save_state('STOPPING')
            self.shutdown()
            self.save_state('STOPPED')

    def supervise(self):
        """Engine down = stop (exit code 3). Tunnel down = keep the engine and retry the tunnel with growing pauses."""
        failures = restarts = ticks = 0
        next_attempt = 0.0
        while not self.stopping:
            time.sleep(1)
            ticks += 1
            if self.server.poll() is not None:
                raise LaunchError(f'Сервер движка завершился (код {self.server.returncode}). См. ./check-cloudcompute.sh logs')
            if not self.cfg.tunnel or ticks % 5:
                continue
            lost = self.tunnel is None or self.tunnel.poll() is not None or not self.url
            if not lost and ticks % 30 == 0:
                try:
                    failures = 0 if verify_tunnel(self.url, self.token) else failures + 1
                except (OSError, ValueError):
                    failures += 1
                lost = failures >= 3
            if not lost:
                restarts = 0
                continue
            if time.monotonic() < next_attempt:
                continue
            restarts += 1
            failures = 0
            quick = self.cfg.tunnel_mode == 'quick'
            log(f'Туннель недоступен, переподключаю (попытка {restarts}).' + (' Ссылка Quick Tunnel изменится.' if quick else ''))
            self.stop_tunnel()
            try:
                self.start_tunnel()
                self.save_state('READY', tunnel_restarts=restarts)
            except LaunchError as exc:
                pause = 0 if restarts < self.cfg.tunnel_restarts else RETRY_PAUSES[min(restarts - self.cfg.tunnel_restarts, len(RETRY_PAUSES) - 1)]
                next_attempt = time.monotonic() + pause
                log(f'Туннель не поднялся: {exc} Следующая попытка через {pause} с; движок продолжает работать.')
                self.stop_tunnel()
                self.save_state('TUNNEL_RETRY', tunnel_restarts=restarts, tunnel_error=str(exc)[:300])


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


def startup_diagnostics(cfg):
    """Credential-free observations only. A saved PID alone is never proof of a live supervisor."""
    def locked(name):
        try:
            with open(cfg.state / name, 'r') as handle:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    fcntl.flock(handle, fcntl.LOCK_UN)
                    return False
                except BlockingIOError:
                    return True
        except OSError:
            return False
    state = local_status(cfg)
    health = state.get('health') or {}
    return {'image_version': VERSION, 'checked_at': int(time.time() * 1000),
            'directories': {name: (cfg.data / name).is_dir() for name in ('config', 'logs', 'runtime', 'models')},
            'provisioning_completed': (cfg.secrets / 'autostart.json').is_file() and (cfg.secrets / 'engine.token').is_file(),
            'supervisor_confirmed': locked('autostart.lock'), 'launcher_running': locked('launcher.lock'),
            'engine_health': health.get('state'), 'gpu_name': health.get('gpu_name'),
            'last_startup_error': (state.get('launcher') or {}).get('last_startup_error')}


def main(argv):
    command = argv[1] if len(argv) > 1 else 'run'
    try:
        cfg = Config()
        if command == 'diagnostics':
            print('YOISAKI_DIAGNOSTICS ' + json.dumps(startup_diagnostics(cfg), ensure_ascii=True))
            return 0
        if command == 'healthcheck':
            token = read_private(cfg, 'token')
            health = request_json(cfg.local + '/health', token, timeout=8) if token else {}
            return 0 if health.get('engine') == 'YOISAKI_ENGINE' and health.get('state') in ('READY', 'BUSY') else 1
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
        if command == 'rotate-token':
            rotate_token(cfg)
            print('Новый токен сохранён. Он начнёт действовать после перезапуска движка (./stop-cloudcompute.sh, затем '
                  './start-cloudcompute.sh). Все сайты, где подключение было запомнено, потеряют доступ: вставьте новую ссылку '
                  '(./check-cloudcompute.sh link) один раз.')
            return 0
        if command != 'run':
            print('Использование: launcher.py [run|healthcheck|link|status|rotate-token]', file=sys.stderr)
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
