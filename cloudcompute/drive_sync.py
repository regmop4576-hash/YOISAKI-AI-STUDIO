"""YOISAKI · Google Drive → CloudCompute model sync (deployment edition 1.7.2, engine protocol 1.7.0).

One-way and read-only:
  source  <remote>:<YOISAKI_DRIVE_PATH>   default yoisaki-gdrive:YOISAKI_AI_STUDIO/models (My Drive)
          or (1.7.3) the folder the user chose on the website: rclone root_folder_id = <Drive folder ID>
  target  $YOISAKI_DATA_ROOT/models/{checkpoints,loras,vae}   = the engine's own catalogue (no second model folder)

Only `rclone lsjson` and `rclone cat` are ever executed (argv lists, no shell): nothing is written, moved or
deleted on Google Drive, and no local model is deleted. Files are downloaded into models/.yoisaki-sync/*.part
(resumable with `rclone cat --offset`), verified (size + the strongest Drive checksum + the engine's
safetensors header/payload check) and only then moved atomically into place. Pickle formats are never accepted.
The OAuth token lives only in $YOISAKI_DATA_ROOT/config/rclone/rclone.conf (0600 in a 0700 folder) and is never
printed, logged or returned.

Stdlib only. CLI: drive_sync.py status | check | sync | connect | disconnect  (see drive-sync-cloudcompute.sh)
"""
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from launcher import Config, LaunchError, write_private  # noqa: E402
from fetch_models import NAME_RE, FetchError, validate  # noqa: E402

# controlnet/ is deliberately not synced: the engine's ControlNet uses its fixed prefetched models (fetch_models.py prefetch).
KIND_FOLDERS = {'checkpoints': 'checkpoint', 'loras': 'lora', 'vae': 'vae'}
# Plausible size windows; anything outside is reported, never downloaded.
LIMITS = {'checkpoint': (256 * 2**20, 32 * 2**30), 'lora': (16 * 2**10, 4 * 2**30), 'vae': (1 * 2**20, 2 * 2**30)}
PICKLE = ('.ckpt', '.pt', '.pth', '.bin', '.pkl', '.pickle')
SEGMENT_RE = re.compile(r'^[\w .()+\-\[\]]{1,120}$')
REMOTE_RE = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$')
HEX = {'sha256': 64, 'sha1': 40, 'md5': 32}
MAX_DEPTH = 4          # kind folder + up to two subfolders + file
MAX_FILES = 2000
MARGIN = 2 * 2**30     # always leave this much free on the model disk
ALLOWED_COMMANDS = ('lsjson', 'cat')  # read-only rclone subcommands; everything else is refused
TOKEN_KEYS = {'access_token', 'token_type', 'refresh_token', 'expiry', 'expires_in'}
CLIENT_ID_RE = re.compile(r'^[0-9]{6,30}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$')
CLIENT_SECRET_RE = re.compile(r'^[A-Za-z0-9_-]{10,100}$')
FOLDER_ID_RE = re.compile(r'^[A-Za-z0-9_-]{10,200}$')
CHUNK = 2**20
PUBLIC_ITEM = ('path', 'name', 'kind', 'size', 'state', 'reason', 'verification')
VERIFICATION_NOTE = ('Проверка: размер + контрольная сумма Google Drive (sha256, sha1 или md5 — что доступно) + заголовок и '
                     'границы данных safetensors. Это контроль целостности передачи, а не криптографическая подпись автора модели.')


class SyncError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def sanitize(text, limit=400):
    """Remove anything token-like from rclone/OS messages before they reach a log, a file or the website."""
    text = str(text)
    text = re.sub(r'"(access_token|refresh_token|client_secret|id_token)"\s*:\s*"[^"]*"', r'"\1":"[СКРЫТО]"', text)
    text = re.sub(r'(token|client_secret|password)\s*=\s*\S+', r'\1=[СКРЫТО]', text, flags=re.I)
    text = re.sub(r'ya29\.[\w.-]+|1//[\w.-]{20,}|GOCSPX-[\w-]+|[a-f0-9]{64}', '[СКРЫТО]', text)
    text = re.sub(r'(Bearer )\S+', r'\1[СКРЫТО]', text)
    text = re.sub(r'^\d{4}/\d\d/\d\d \d\d:\d\d:\d\d ', '', text, flags=re.M)
    return ' '.join(text.split())[:limit]


def classify_rclone_error(stderr, returncode):
    low = stderr.lower()
    if 'didn\'t find section in config file' in low or 'config file not found' in low:
        return SyncError('NOT_CONFIGURED', 'Google Drive не подключён на сервере.')
    if any(x in low for x in ('invalid_grant', 'unauthorized_client', 'oauth2', 'token expired', 'invalid_client', '401')):
        return SyncError('AUTH_FAILED', 'Google отклонил авторизацию. Подключите Google Drive заново (новый токен rclone authorize).')
    if 'directory not found' in low or 'object not found' in low or 'file not found' in low:
        return SyncError('SOURCE_NOT_FOUND', 'Папка или файл не найдены на Google Drive. Проверьте выбранную папку моделей '
                                             '(на сайте: Модели → Google Drive → Изменить папку).')
    if any(x in low for x in ('ratelimitexceeded', 'userratelimitexceeded', 'quota', 'downloadquotaexceeded', '403')):
        return SyncError('RATE_LIMITED', 'Google Drive временно ограничил запросы или скачивание. Повторите позже.')
    if any(x in low for x in ('no such host', 'dial tcp', 'timeout', 'connection reset', 'tls', 'network is unreachable')):
        return SyncError('NETWORK', 'Нет связи с Google Drive. Повторите позже; загрузка продолжится с места остановки.')
    return SyncError('RCLONE_ERROR', f'rclone завершился с кодом {returncode}: {sanitize(stderr, 240) or "без сообщения"}')


class SyncConfig:
    """Paths derive from the launcher configuration, so the sync target IS the engine catalogue."""

    def __init__(self, environ=None):
        e = os.environ if environ is None else environ
        base = Config(e)
        self.data, self.models, self.engine = base.data, base.models, base.engine
        self.state = self.data / 'runtime/sync'
        self.staging = self.models / '.yoisaki-sync'  # same filesystem/mount as the targets: rename is atomic
        self.rclone_dir = self.data / 'config/rclone'
        self.rclone_conf = self.rclone_dir / 'rclone.conf'
        self.source_file = self.state / 'source.json'  # 1.7.3: folder chosen on the website (ID + display label)
        self.remote = e.get('YOISAKI_DRIVE_REMOTE', 'yoisaki-gdrive').strip()
        if not REMOTE_RE.match(self.remote):
            raise LaunchError('YOISAKI_DRIVE_REMOTE: только латиница, цифры, _ и - (до 64 символов).')
        source = e.get('YOISAKI_DRIVE_PATH', 'YOISAKI_AI_STUDIO/models').strip().strip('/')
        parts = source.split('/')
        if not source or len(parts) > 8 or any(not SEGMENT_RE.match(p) or p in ('.', '..') for p in parts) or ':' in source:
            raise LaunchError('YOISAKI_DRIVE_PATH должен быть относительным путём в «Мой диск» без «..» и «:».')
        self.source = source
        self.rclone = e.get('YOISAKI_RCLONE') or shutil.which('rclone') or str(self.data / 'runtime/bin/rclone')
        self.enabled = e.get('YOISAKI_DRIVE_SYNC', '1') != '0'

    def target(self, rel):
        """Final path of a validated relative path; refuses anything that would leave the kind folder."""
        parts = rel.split('/')
        folder = (self.models / parts[0]).resolve()
        final = self.models.joinpath(*parts)
        parent = final.parent.resolve()
        if not (parent == folder or parent.is_relative_to(folder)) or not folder.is_relative_to(self.models.resolve()):
            raise SyncError('UNSAFE_PATH', 'Путь выходит за пределы папки моделей.')
        return final


# ---------------------------------------------------------------------------------------------- rclone
def rclone_argv(cfg, command, *args):
    if command not in ALLOWED_COMMANDS:
        raise SyncError('FORBIDDEN', 'Разрешены только операции чтения rclone (lsjson, cat).')
    return [cfg.rclone, '--config', str(cfg.rclone_conf), command, '--drive-scope', 'drive.readonly',
            '--contimeout', '30s', '--timeout', '120s', '--low-level-retries', '5', '--log-level', 'ERROR', *args]


def rclone_env(cfg):
    env = {k: v for k, v in os.environ.items() if not k.startswith('RCLONE_')}
    env.update(RCLONE_CONFIG=str(cfg.rclone_conf), HOME=str(cfg.data / 'runtime/home'),
               XDG_CACHE_HOME=str(cfg.data / 'runtime/home/.cache'))
    return env


def folder_override(cfg):
    """1.7.3: {'folder_id', 'label'} of the folder chosen on the website, or None (YOISAKI_DRIVE_PATH is used)."""
    try:
        value = json.loads(cfg.source_file.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(value, dict) or not FOLDER_ID_RE.match(str(value.get('folder_id', ''))):
        return None
    return {'folder_id': value['folder_id'], 'label': sanitize(value.get('label') or '', 300)}


def remote_spec(cfg, rel=''):
    # With a chosen folder rclone.conf carries root_folder_id, so the remote root IS that folder.
    if folder_override(cfg):
        return f'{cfg.remote}:{rel}'
    return f'{cfg.remote}:{cfg.source}' + (f'/{rel}' if rel else '')


def config_state(cfg):
    """(configured, type) without ever reading the token value out of the file."""
    try:
        text = cfg.rclone_conf.read_text()
    except OSError:
        return False, None
    section = re.search(r'^\[' + re.escape(cfg.remote) + r'\]\s*$(.*?)(?=^\[|\Z)', text, re.M | re.S)
    if not section:
        return False, None
    kind = re.search(r'^type\s*=\s*(\S+)', section.group(1), re.M)
    return True, kind.group(1) if kind else None


# ---------------------------------------------------------------------------------------------- inventory
def best_hash(hashes):
    for name in ('sha256', 'sha1', 'md5'):
        value = (hashes or {}).get(name)
        if isinstance(value, str) and re.fullmatch(f'[a-f0-9]{{{HEX[name]}}}', value.lower()):
            return name, value.lower()
    return None, None


def classify(entry):
    """Remote listing row → inventory item. Never trusts the remote path or size."""
    rel = entry.get('Path') if isinstance(entry, dict) else None
    if not isinstance(rel, str) or not rel or entry.get('IsDir'):
        return None
    parts = rel.split('/')
    kind = KIND_FOLDERS.get(parts[0])
    if kind is None or len(parts) < 2:
        return None  # outside checkpoints/ loras/ vae/: not a model folder of this sync
    name = parts[-1]
    size = entry.get('Size')
    item = {'path': rel, 'name': name, 'kind': kind, 'size': size if type(size) is int and size >= 0 else None, 'state': 'REJECTED', 'reason': '',
            'modtime': str(entry.get('ModTime', ''))[:40]}
    item['hash_type'], item['hash'] = best_hash(entry.get('Hashes'))
    low = name.lower()
    if len(rel) > 400 or '\\' in rel or '\x00' in rel or len(parts) > MAX_DEPTH or any(
            p in ('.', '..') or p.startswith('.') or not SEGMENT_RE.match(p) for p in parts):
        item['reason'] = 'Небезопасное имя или путь (разрешены буквы, цифры, пробел и ._-()+[]; без скрытых папок).'
    elif low.endswith(PICKLE):
        item['reason'] = 'Формат pickle (.ckpt/.pt/.bin) не загружается: он может выполнять код. Используйте .safetensors.'
    elif not low.endswith('.safetensors'):
        item['reason'] = 'Неподдерживаемый формат: движок принимает только .safetensors.'
    elif not NAME_RE.match(name):
        item['reason'] = 'Недопустимое имя файла.'
    elif type(item['size']) is not int:
        item['reason'] = 'Google Drive не сообщил размер файла.'
    elif not LIMITS[kind][0] <= item['size'] <= LIMITS[kind][1]:
        lo, hi = LIMITS[kind]
        item['reason'] = f'Размер {fmt(item["size"])} вне допустимого для {kind} ({fmt(lo)}–{fmt(hi)}).'
    else:
        item['state'] = 'PENDING'
    return item


def fmt(n):
    return f'{n / 2**30:.2f} ГБ' if n >= 2**30 else f'{n / 2**20:.1f} МБ' if n >= 2**20 else f'{n / 2**10:.0f} КБ'


def file_hash(path, kind, cancel=None, progress=None):
    h = hashlib.new(kind)
    done = 0
    with path.open('rb') as f:
        while chunk := f.read(8 * CHUNK):
            if cancel is not None and cancel.is_set():
                raise SyncError('CANCELLED', 'Отменено.')
            h.update(chunk)
            done += len(chunk)
            if progress:
                progress(done)
    return h.hexdigest()


def stamp(path):
    st = path.stat()
    return {'local_size': st.st_size, 'local_mtime_ns': st.st_mtime_ns}


# ---------------------------------------------------------------------------------------------- service
class SyncService:
    """One sync/check job at a time per data root (thread lock + flock shared with the CLI)."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.lock = threading.RLock()
        self.cancel_event = threading.Event()
        self.thread = None
        self.process = None
        self.lock_file = None
        self._saved = 0.0
        self.job = None
        self.items = []
        self.last_success_unix = None
        self.last_check_unix = None
        self.connection = {'state': 'UNKNOWN', 'error': '', 'code': ''}
        self.revision = 0
        self.offsets = {}
        persisted = self._read_status()
        if persisted:
            self.items = persisted.get('items') or []
            self.last_success_unix = persisted.get('last_success_unix')
            self.last_check_unix = persisted.get('last_check_unix')
            self.connection = persisted.get('connection') or self.connection
            self.revision = int(persisted.get('inventory_revision') or 0)
            job = persisted.get('job')
            if job and job.get('state') == 'RUNNING' and not self._held_elsewhere():
                job.update(state='INTERRUPTED', error='Синхронизация была прервана (перезапуск). Запустите её снова — загрузка продолжится.',
                           error_code='INTERRUPTED', current=None)
            self.job = job

    # -- persistence -------------------------------------------------------------------------
    def _status_path(self):
        return self.cfg.state / 'status.json'

    def _read_status(self):
        try:
            return json.loads(self._status_path().read_text())
        except (OSError, ValueError):
            return None

    def _ensure_dirs(self):
        for d in (self.cfg.state, self.cfg.staging):
            d.mkdir(parents=True, exist_ok=True)
            os.chmod(d, 0o700)

    def _save(self, force=False):
        now = time.monotonic()
        if not force and now - self._saved < 1.0:
            return
        self._saved = now
        try:
            self._ensure_dirs()
            write_private(self._status_path(), json.dumps(self._snapshot(), ensure_ascii=False))
        except OSError:
            pass

    def _held_elsewhere(self):
        path = self.cfg.state / 'sync.lock'
        if not path.exists():
            return False
        try:
            with open(path, 'a') as f:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(f, fcntl.LOCK_UN)
            return False
        except OSError:
            return True

    def manifest(self):
        try:
            value = json.loads((self.cfg.state / 'manifest.json').read_text())
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save_manifest(self, manifest):
        self._ensure_dirs()
        write_private(self.cfg.state / 'manifest.json', json.dumps(manifest, ensure_ascii=False, indent=1))

    # -- public API ----------------------------------------------------------------------------
    def _snapshot(self):
        with self.lock:
            configured, _ = config_state(self.cfg)
            override = folder_override(self.cfg)
            try:
                usage = shutil.disk_usage(self.cfg.models if self.cfg.models.exists() else self.cfg.data)
                disk = {'free_bytes': usage.free, 'total_bytes': usage.total, 'reserve_bytes': MARGIN}
            except OSError:
                disk = None
            return {'service': 'YOISAKI_DRIVE_SYNC', 'version': 1, 'enabled': self.cfg.enabled,
                    'rclone_available': Path(self.cfg.rclone).is_file() and os.access(self.cfg.rclone, os.X_OK),
                    'configured': configured, 'connection': dict(self.connection),
                    'source': (override or {}).get('label') or self.cfg.source, 'source_kind': 'folder' if override else 'path',
                    'scope': 'drive.readonly', 'job': json.loads(json.dumps(self.job)) if self.job else None,
                    # Only what the page shows: no Drive IDs, checksums or server paths.
                    'items': [{k: i.get(k) for k in PUBLIC_ITEM} for i in self.items], 'disk': disk, 'last_success_unix': self.last_success_unix,
                    'last_check_unix': self.last_check_unix, 'inventory_revision': self.revision,
                    'verification': VERIFICATION_NOTE, 'owner': 'self', 'selective': True, 'folder_select': True}

    def status(self):
        with self.lock:
            running = self.thread is not None and self.thread.is_alive()
        if not running and self._held_elsewhere():
            other = self._read_status() or {}
            snap = self._snapshot()
            snap.update({k: other[k] for k in ('job', 'items', 'last_success_unix', 'last_check_unix', 'inventory_revision', 'connection') if k in other})
            snap['owner'] = 'other'  # a CLI sync on the server holds the lock
            return snap
        return self._snapshot()

    def start(self, kind, paths=None):
        """paths (1.7.3, sync only): download just these Drive paths from the check list; None = everything missing."""
        if kind not in ('check', 'sync'):
            raise SyncError('INVALID', 'Неизвестная операция.')
        if paths is not None and (kind != 'sync' or not isinstance(paths, list) or not paths or len(paths) > MAX_FILES
                                  or any(not isinstance(x, str) or not x or len(x) > 400 for x in paths)):
            raise SyncError('INVALID', 'Неверный выбор файлов для синхронизации.')
        if not self.cfg.enabled:
            raise SyncError('DISABLED', 'Синхронизация отключена на сервере (YOISAKI_DRIVE_SYNC=0).')
        if not (Path(self.cfg.rclone).is_file() and os.access(self.cfg.rclone, os.X_OK)):
            raise SyncError('RCLONE_MISSING', 'rclone не установлен на сервере. Повторите ./start-cloudcompute.sh (образ/окружение 1.7.2).')
        if not config_state(self.cfg)[0]:
            raise SyncError('NOT_CONFIGURED', 'Google Drive не подключён. Нажмите «Подключить Google Drive».')
        # The staging folder (or models/, to create it) must be writable; a read-only mount fails here with EROFS.
        if not os.access(self.cfg.staging if self.cfg.staging.exists() else self.cfg.models, os.W_OK):
            raise SyncError('READ_ONLY', 'Папка моделей на сервере доступна только для чтения. Перезапустите движок через '
                                         './start-cloudcompute.sh (с YOISAKI_DRIVE_SYNC=1 он монтирует models на запись).')
        with self.lock:
            if self.thread is not None and self.thread.is_alive():
                raise SyncError('BUSY', 'Синхронизация уже выполняется.')
            self._ensure_dirs()
            handle = open(self.cfg.state / 'sync.lock', 'a')
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                handle.close()
                raise SyncError('BUSY', 'Синхронизация уже выполняется другим процессом (например, из терминала сервера).')
            self.lock_file = handle
            self.cancel_event.clear()
            self.job = {'id': uuid.uuid4().hex[:12], 'type': kind, 'state': 'RUNNING', 'phase': 'LISTING',
                        'started_unix': time.time(), 'finished_unix': None, 'error': '', 'error_code': '',
                        'current': None, 'overall': {'files_total': 0, 'files_done': 0, 'files_failed': 0, 'bytes_total': 0, 'bytes_done': 0},
                        'summary': {}, 'cancel_requested': False, 'restart_recommended': False}
            self.thread = threading.Thread(target=self._run, args=(kind, None if paths is None else set(paths)),
                                           name='yoisaki-drive-sync', daemon=True)
            self.thread.start()
        self._save(force=True)
        return self.status()

    def cancel(self):
        with self.lock:
            if self.thread is None or not self.thread.is_alive():
                if self._held_elsewhere():
                    raise SyncError('BUSY', 'Синхронизацию запустили на сервере из терминала: отмените её там (Ctrl+C).')
                return self.status()
            self.cancel_event.set()
            self.job['cancel_requested'] = True
            process = self.process
        if process is not None and process.poll() is None:
            process.terminate()
        return self.status()

    def wait(self, timeout=None):
        thread = self.thread
        if thread is not None:
            thread.join(timeout)

    def connect(self, token, client_id='', client_secret='', folder_id='', folder_label=''):
        """Store a read-only Drive token (browser sign-in on the website or `rclone authorize`) as the sync remote.

        1.7.3: folder_id = the model folder chosen on the website (a Drive folder ID, used as rclone root_folder_id);
        empty keeps YOISAKI_DRIVE_PATH. The ID only narrows what the read-only token can already see."""
        if isinstance(token, str):
            try:
                token = json.loads(token.strip())
            except ValueError:
                raise SyncError('INVALID_TOKEN', 'Вставьте JSON-токен целиком: {"access_token":…,"refresh_token":…}.')
        if (not isinstance(token, dict) or not set(token) <= TOKEN_KEYS or not {'access_token', 'refresh_token'} <= set(token)
                or any(not isinstance(v, (str, int)) or isinstance(v, bool) or len(str(v)) > 4096 or re.search(r'[\x00-\x1f\x7f]', str(v)) for v in token.values())
                or not str(token['refresh_token']).strip()):
            raise SyncError('INVALID_TOKEN', 'Это не токен rclone authorize для Google Drive. Скопируйте строку {"access_token":…} целиком.')
        if bool(client_id) != bool(client_secret) or client_id and (not CLIENT_ID_RE.match(client_id) or not CLIENT_SECRET_RE.match(client_secret)):
            raise SyncError('INVALID_CLIENT', 'Client ID и Client Secret указываются вместе и только из вашего OAuth-клиента Google.')
        if folder_id and not FOLDER_ID_RE.match(folder_id) or not isinstance(folder_label, str) or len(folder_label) > 300:
            raise SyncError('INVALID_FOLDER', 'Неверный идентификатор папки Google Drive.')
        with self.lock:
            if self.thread is not None and self.thread.is_alive():
                raise SyncError('BUSY', 'Дождитесь окончания синхронизации.')
            self.cfg.rclone_dir.mkdir(parents=True, exist_ok=True)
            os.chmod(self.cfg.rclone_dir, 0o700)
            lines = [f'[{self.cfg.remote}]', 'type = drive', 'scope = drive.readonly',
                     'token = ' + json.dumps(token, separators=(',', ':'))]
            if client_id:
                lines += [f'client_id = {client_id}', f'client_secret = {client_secret}']
            if folder_id:
                lines.append(f'root_folder_id = {folder_id}')
            write_private(self.cfg.rclone_conf, '\n'.join(lines) + '\n')
            self._ensure_dirs()
            if folder_id:
                write_private(self.cfg.source_file, json.dumps({'folder_id': folder_id, 'label': sanitize(folder_label, 300)}, ensure_ascii=False))
            else:
                self.cfg.source_file.unlink(missing_ok=True)
            self.connection = {'state': 'UNKNOWN', 'error': '', 'code': ''}
        self._save(force=True)
        return self.status()

    def disconnect(self):
        """Removes the server copy of the token only. Revoke access in the Google account to invalidate it."""
        with self.lock:
            if self.thread is not None and self.thread.is_alive():
                raise SyncError('BUSY', 'Дождитесь окончания синхронизации.')
            self.cfg.rclone_conf.unlink(missing_ok=True)
            self.cfg.source_file.unlink(missing_ok=True)
            self.connection = {'state': 'UNKNOWN', 'error': '', 'code': ''}
        self._save(force=True)
        return self.status()

    # -- job -----------------------------------------------------------------------------------
    def _update(self, **fields):
        with self.lock:
            self.job.update(fields)
        self._save()

    def _check_cancel(self):
        if self.cancel_event.is_set():
            raise SyncError('CANCELLED', 'Синхронизация отменена. Частично загруженный файл сохранён для продолжения.')

    def _run(self, kind, paths=None):
        try:
            items = self._discover()
            with self.lock:
                self.items = items
                self.last_check_unix = time.time()
                self.connection = {'state': 'OK', 'error': '', 'code': ''}
            if kind == 'sync':
                self._download_all(items, paths)
            summary = {s.lower(): sum(i['state'] == s for i in items) for s in ('INSTALLED', 'MISSING', 'CHANGED', 'CONFLICT', 'REJECTED', 'FAILED')}
            with self.lock:
                self.job.update(state='COMPLETED', phase='DONE', current=None, summary={**self.job.get('summary', {}), **summary})
                if kind == 'sync' and not summary['failed']:
                    self.last_success_unix = time.time()
        except SyncError as exc:
            with self.lock:
                cancelled = exc.code == 'CANCELLED'
                self.job.update(state='CANCELLED' if cancelled else 'FAILED', error=str(exc), error_code=exc.code, current=None)
                if exc.code in ('AUTH_FAILED', 'NOT_CONFIGURED', 'SOURCE_NOT_FOUND', 'NETWORK', 'RATE_LIMITED'):
                    self.connection = {'state': 'ERROR', 'error': str(exc), 'code': exc.code}
        except Exception as exc:  # never leave a job RUNNING; the message is sanitised
            with self.lock:
                self.job.update(state='FAILED', error=f'Внутренняя ошибка синхронизации: {type(exc).__name__}: {sanitize(exc, 200)}',
                                error_code='INTERNAL', current=None)
        finally:
            with self.lock:
                self.job['finished_unix'] = time.time()
                self.process = None
                if self.lock_file is not None:
                    self.lock_file.close()  # releases the flock
                    self.lock_file = None
            self._save(force=True)

    def _popen(self, command, *args):
        process = subprocess.Popen(rclone_argv(self.cfg, command, *args), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   stdin=subprocess.DEVNULL, env=rclone_env(self.cfg), start_new_session=True)
        with self.lock:
            self.process = process
        return process

    def _discover(self):
        self._update(phase='LISTING', current=None)
        process = self._popen('lsjson', '-R', '--files-only', '--hash', '--no-mimetype', '--drive-skip-gdocs',
                              '--max-depth', str(MAX_DEPTH), remote_spec(self.cfg))
        try:
            raw, err = process.communicate(timeout=900)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise SyncError('NETWORK', 'Google Drive не ответил на запрос списка файлов за 15 минут.')
        self._check_cancel()
        if process.returncode:
            raise classify_rclone_error(err.decode(errors='replace'), process.returncode)
        try:
            rows = json.loads(raw.decode('utf-8'))
            assert isinstance(rows, list)
        except (ValueError, AssertionError, UnicodeDecodeError):
            raise SyncError('INVALID_LISTING', 'rclone вернул неверный список файлов.')
        if len(rows) > MAX_FILES:
            raise SyncError('TOO_MANY_FILES', f'В папке моделей больше {MAX_FILES} файлов. Разделите библиотеку.')
        items = [i for i in (classify(r) for r in rows) if i is not None]
        self._update(phase='COMPARING')
        manifest = self.manifest()
        changed = False
        for item in items:
            self._check_cancel()
            if item['state'] != 'PENDING':
                continue
            changed |= self._compare(item, manifest)
        if changed:
            self._save_manifest(manifest)
        return sorted(items, key=lambda i: (i['kind'], i['path'].lower()))

    def _compare(self, item, manifest):
        """Sets item['state']. Returns True when the manifest was updated (adoption of an existing file)."""
        try:
            local = self.cfg.target(item['path'])
        except SyncError as exc:
            item.update(state='REJECTED', reason=str(exc))
            return False
        if local.is_symlink() or local.exists() and not local.is_file():
            item.update(state='CONFLICT', reason='На сервере по этому пути не обычный файл; он не изменяется.')
            return False
        if not local.exists():
            item['state'] = 'MISSING'
            return False
        record = manifest.get(item['path'])
        same_remote = bool(record) and record.get('size') == item['size'] and (
            record.get('hash') == item['hash'] if item['hash'] else record.get('modtime') == item['modtime'])
        if record and record.get('local_size') == local.stat().st_size and record.get('local_mtime_ns') == local.stat().st_mtime_ns:
            # Installed by this sync and untouched since: an updated Drive file may replace it.
            item['state'] = 'INSTALLED' if same_remote else 'CHANGED'
            if item['state'] == 'CHANGED':
                item['reason'] = 'Файл на Google Drive изменился: будет загружена новая версия.'
            return False
        # A file placed by hand (fetch-models, scp) or modified locally: adopt only when identical.
        if local.stat().st_size != item['size']:
            item.update(state='CONFLICT', reason='На сервере уже есть другой файл с этим именем. Он не перезаписывается.')
            return False
        if item['hash']:
            self._update(phase='HASHING_LOCAL', current={'path': item['path'], 'kind': item['kind'], 'phase': 'HASHING_LOCAL',
                                                          'bytes_done': 0, 'bytes_total': item['size'], 'speed_bps': None})
            digest = file_hash(local, item['hash_type'], self.cancel_event,
                               lambda n: self._progress(n, item['size'], None))
            self._update(phase='COMPARING', current=None)
            if digest != item['hash']:
                item.update(state='CONFLICT', reason='Файл на сервере отличается от Google Drive (контрольная сумма). Он не перезаписывается.')
                return False
            level = item['hash_type']
        else:
            level = 'size'
        manifest[item['path']] = {'size': item['size'], 'hash_type': item['hash_type'], 'hash': item['hash'], 'modtime': item['modtime'],
                                  'verification': level, 'adopted': True, 'installed_unix': time.time(), **stamp(local)}
        item['state'] = 'INSTALLED'
        return True

    def _progress(self, done, total, speed):
        with self.lock:
            if self.job and self.job.get('current'):
                self.job['current'].update(bytes_done=done, bytes_total=total, speed_bps=speed)
        self._save()

    def _download_all(self, items, paths=None):
        # Paths only select among what this server itself listed on Drive: an unknown path selects nothing.
        todo = [i for i in items if i['state'] in ('MISSING', 'CHANGED') and (paths is None or i['path'] in paths)]
        self.offsets = {i['path']: self._part_offset(i) for i in todo}  # resumed bytes count as done
        total = sum(i['size'] for i in todo)
        done = sum(self.offsets.values())
        self._update(phase='DOWNLOADING' if todo else 'DONE',
                     overall={'files_total': len(todo), 'files_done': 0, 'files_failed': 0, 'bytes_total': total, 'bytes_done': done})
        free = shutil.disk_usage(self.cfg.models).free
        if todo and free < total - done + MARGIN:
            raise SyncError('DISK_SPACE', f'Недостаточно места на диске моделей: нужно {fmt(total - done + MARGIN)} '
                                          f'(включая резерв {fmt(MARGIN)}), свободно {fmt(free)}. Ничего не загружено.')
        manifest = self.manifest()
        replaced = False
        for item in todo:
            self._check_cancel()
            original = item['state']
            try:
                self._download(item, manifest)
                replaced |= item.pop('_replaced', False)
                with self.lock:
                    self.job['overall']['files_done'] += 1
                    self.revision += 1
            except SyncError as exc:
                if exc.code == 'CANCELLED':
                    item.update(state=original, reason='Загрузка отменена; при следующей синхронизации продолжится с места остановки.')
                    raise
                if exc.code in ('DISK_SPACE', 'AUTH_FAILED', 'NOT_CONFIGURED', 'NETWORK', 'RATE_LIMITED'):
                    item.update(state='FAILED', reason=str(exc))
                    raise
                item.update(state='FAILED', reason=str(exc))
                with self.lock:
                    self.job['overall']['files_failed'] += 1
            self._save(force=True)
        with self.lock:
            self.job['restart_recommended'] = replaced
            self.job['summary'] = {'downloaded': self.job['overall']['files_done']}

    def _part_paths(self, item):
        key = hashlib.sha256(item['path'].encode()).hexdigest()[:24]
        return self.cfg.staging / (key + '.part'), self.cfg.staging / (key + '.part.json')

    def _part_offset(self, item):
        part, meta = self._part_paths(item)
        try:
            info = json.loads(meta.read_text())
            if info == self._part_identity(item) and part.stat().st_size <= item['size']:
                return part.stat().st_size
        except (OSError, ValueError):
            pass
        return 0

    @staticmethod
    def _part_identity(item):
        return {'path': item['path'], 'size': item['size'], 'hash_type': item['hash_type'], 'hash': item['hash'], 'modtime': item['modtime']}

    def _download(self, item, manifest):
        part, meta = self._part_paths(item)
        final = self.cfg.target(item['path'])
        offset = self._part_offset(item)
        if not offset:
            # Our own temporary file from another remote version (or none): start from zero.
            part.unlink(missing_ok=True)
            write_private(meta, json.dumps(self._part_identity(item)))
        hasher = hashlib.new(item['hash_type']) if item['hash'] else None
        current = {'path': item['path'], 'kind': item['kind'], 'phase': 'DOWNLOADING', 'bytes_done': offset,
                   'bytes_total': item['size'], 'speed_bps': None, 'resumed_from': offset or None}
        self._update(phase='DOWNLOADING', current=current)
        item['state'] = 'DOWNLOADING'
        if offset and hasher:
            self._update(current={**current, 'phase': 'VERIFYING_PARTIAL'})
            with part.open('rb') as f:
                while chunk := f.read(8 * CHUNK):
                    self._check_cancel()
                    hasher.update(chunk)
            self._update(current={**current, 'phase': 'DOWNLOADING'})
        attempts = 0
        while True:
            self._check_cancel()
            free = shutil.disk_usage(self.cfg.models).free
            if free < item['size'] - offset + MARGIN:
                raise SyncError('DISK_SPACE', f'Недостаточно места для {item["name"]}: нужно {fmt(item["size"] - offset + MARGIN)}, свободно {fmt(free)}.')
            offset, error = self._transfer(item, part, offset, hasher)
            if offset == item['size'] and error is None:
                break
            if offset > item['size']:
                part.unlink(missing_ok=True)
                raise SyncError('VERIFY_FAILED', f'{item["name"]}: получено больше данных, чем объявил Google Drive. Файл отброшен.')
            if error is not None and error.code in ('AUTH_FAILED', 'NOT_CONFIGURED', 'SOURCE_NOT_FOUND', 'RATE_LIMITED'):
                raise error
            attempts += 1
            if attempts >= 3:
                raise error or SyncError('INCOMPLETE', f'{item["name"]}: передача прервалась ({fmt(offset)} из {fmt(item["size"])}). '
                                                       'Повторите синхронизацию — загрузка продолжится.')
            for _ in range(2 * attempts * 10):  # 2 s, 4 s back-off, interruptible
                self._check_cancel()
                time.sleep(0.1)
        # -- verify
        item['state'] = 'VERIFYING'
        self._update(phase='VERIFYING', current={**current, 'phase': 'VERIFYING', 'bytes_done': item['size'], 'speed_bps': None})
        if hasher is not None and hasher.hexdigest() != item['hash']:
            part.unlink(missing_ok=True)
            meta.unlink(missing_ok=True)
            raise SyncError('VERIFY_FAILED', f'{item["name"]}: контрольная сумма {item["hash_type"]} не совпала с Google Drive. Файл отброшен.')
        with part.open('rb+') as f:
            os.fsync(f.fileno())
        try:
            validate(part, item['kind'], self.cfg)  # engine catalogue code: header, kind, payload size; nothing is executed
        except FetchError as exc:
            part.unlink(missing_ok=True)
            meta.unlink(missing_ok=True)
            raise SyncError('INVALID_MODEL', f'{item["name"]}: {exc}')
        # -- install atomically
        self._update(phase='INSTALLING', current={**current, 'phase': 'INSTALLING', 'bytes_done': item['size']})
        final.parent.mkdir(parents=True, exist_ok=True)
        final = self.cfg.target(item['path'])  # re-check containment after creating subfolders
        if final.is_symlink() or final.exists() and not final.is_file():
            raise SyncError('CONFLICT', f'{item["name"]}: по пути назначения не обычный файл. Установка отменена.')
        if final.exists():
            record = manifest.get(item['path'])
            if not record or record.get('local_size') != final.stat().st_size or record.get('local_mtime_ns') != final.stat().st_mtime_ns:
                raise SyncError('CONFLICT', f'{item["name"]}: файл на сервере изменён вручную во время загрузки. Он не перезаписан.')
            item['_replaced'] = True
        os.chmod(part, 0o644)
        os.replace(part, final)
        meta.unlink(missing_ok=True)
        try:
            fd = os.open(final.parent, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        except OSError:
            pass
        manifest[item['path']] = {'size': item['size'], 'hash_type': item['hash_type'], 'hash': item['hash'], 'modtime': item['modtime'],
                                  'verification': (item['hash_type'] or 'size') + '+safetensors', 'adopted': False,
                                  'installed_unix': time.time(), **stamp(final)}
        self._save_manifest(manifest)
        item.update(state='INSTALLED', reason='', verification=manifest[item['path']]['verification'])

    def _transfer(self, item, part, offset, hasher):
        """One rclone cat attempt appended to the part file. Returns (new offset, error or None)."""
        args = ['--offset', str(offset)] if offset else []
        process = self._popen('cat', *args, remote_spec(self.cfg, item['path']))
        stderr = []
        reader = threading.Thread(target=lambda: stderr.append(process.stderr.read().decode(errors='replace')[-65536:]), daemon=True)
        reader.start()
        window = [(time.monotonic(), offset)]
        speed = None
        try:
            with part.open('ab') as f:
                while chunk := process.stdout.read(CHUNK):
                    if self.cancel_event.is_set():
                        break
                    if offset + len(chunk) > item['size']:
                        offset += len(chunk)
                        break
                    f.write(chunk)
                    if hasher is not None:
                        hasher.update(chunk)
                    offset += len(chunk)
                    now = time.monotonic()
                    window.append((now, offset))
                    while len(window) > 2 and now - window[0][0] > 5:
                        window.pop(0)
                    if now - window[0][0] >= 0.5:
                        speed = round((offset - window[0][1]) / (now - window[0][0]))
                    with self.lock:
                        self.offsets[item['path']] = offset
                        self.job['overall']['bytes_done'] = sum(self.offsets.values())
                    self._progress(offset, item['size'], speed)
                f.flush()
                os.fsync(f.fileno())
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(10)
                except subprocess.TimeoutExpired:
                    process.kill()
            process.wait()
            reader.join(5)
        self._check_cancel()
        if process.returncode and offset < item['size']:
            return offset, classify_rclone_error(''.join(stderr), process.returncode)
        return offset, None


# ---------------------------------------------------------------------------------------------- CLI
def print_status(snap):
    configured = 'да' if snap['configured'] else 'нет'
    where = f"папка «{snap['source']}» (выбрана на сайте)" if snap.get('source_kind') == 'folder' else f"Мой диск/{snap['source']}"
    print(f"Google Drive подключён: {configured} · источник: {where} · доступ: {snap['scope']}")
    print('rclone: ' + ('установлен' if snap['rclone_available'] else 'НЕ НАЙДЕН'))
    if snap['disk']:
        print(f"Свободно на диске моделей: {fmt(snap['disk']['free_bytes'])} из {fmt(snap['disk']['total_bytes'])}")
    if snap['last_success_unix']:
        print('Последняя успешная синхронизация: ' + time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(snap['last_success_unix'])))
    job = snap.get('job')
    if job:
        print(f"Последняя операция: {job['type']} · {job['state']}" + (f" · {job['error']}" if job.get('error') else ''))
    for item in snap['items']:
        print(f"  {item['state']:<10} {item['kind']:<10} {fmt(item['size']) if isinstance(item['size'], int) else '—':>10}  {item['path']}"
              + (f"  ({item['reason']})" if item.get('reason') else ''))
    print(snap['verification'])


def run_foreground(service, kind):
    stop = {'n': 0}

    def interrupt(_signum, _frame):
        stop['n'] += 1
        service.cancel()
    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGTERM, interrupt)
    service.start(kind)
    last = ''
    while service.thread.is_alive():
        service.wait(2)
        job = service.status()['job'] or {}
        cur = job.get('current') or {}
        line = f"[{job.get('phase')}]"
        if cur:
            speed = f" · {fmt(cur['speed_bps'])}/с" if cur.get('speed_bps') else ''
            line += f" {cur['path']}: {fmt(cur['bytes_done'])} / {fmt(cur['bytes_total'])}{speed}"
        overall = job.get('overall') or {}
        if overall.get('files_total'):
            line += f" · файлов {overall['files_done']}/{overall['files_total']}"
        if line != last:
            print(line, flush=True)
            last = line
    snap = service.status()
    print_status(snap)
    job = snap['job']
    if job['state'] == 'COMPLETED' and job.get('restart_recommended'):
        print('Обновлена модель, которая могла быть загружена в память: она применится после выбора другой модели или перезапуска движка.')
    return 0 if job['state'] == 'COMPLETED' and not job['summary'].get('failed') else 1


def main(argv):
    command = argv[1] if len(argv) > 1 else 'status'
    try:
        service = SyncService(SyncConfig())
        if command == 'status':
            print_status(service.status())
            return 0
        if command in ('check', 'sync'):
            return run_foreground(service, command)
        if command == 'connect':
            raw = sys.stdin.read(65536)  # never from argv: the token must not appear in the process list
            try:
                doc = json.loads(raw.strip() or 'null')
            except ValueError:
                raise SyncError('INVALID_TOKEN', 'Ожидался JSON-токен из rclone authorize.')
            if isinstance(doc, dict) and 'token' in doc:
                service.connect(doc['token'], doc.get('client_id') or '', doc.get('client_secret') or '')
            else:
                service.connect(doc)
            print('Токен сохранён на сервере (права 0600). Проверка доступа к Google Drive…')
            return run_foreground(service, 'check')
        if command == 'disconnect':
            service.disconnect()
            print('Токен удалён с сервера. Чтобы отозвать доступ полностью: myaccount.google.com → Безопасность → Сторонние приложения → rclone.')
            return 0
        print('Использование: drive_sync.py status|check|sync|connect|disconnect', file=sys.stderr)
        return 2
    except SyncError as exc:
        print(f'ОШИБКА ({exc.code}): {exc}', file=sys.stderr)
        return 1
    except LaunchError as exc:
        print('ОШИБКА: ' + str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    os.umask(0o022)
    sys.exit(main(sys.argv))
