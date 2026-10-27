"""Model downloads for CloudCompute. Existing files are never overwritten or deleted.

  fetch_models.py list
  fetch_models.py url <URL> --kind checkpoint|lora|vae [--name file.safetensors]
  fetch_models.py gdrive <share link or file id> --kind ... --name file.safetensors
  fetch_models.py prefetch [--only sdxl-config,controlnet,annotators,depth,sdpose]

`url`/`gdrive` resume an interrupted download (*.part), check free disk space first and validate the
safetensors header with the engine's own catalogue code before the file appears in models/.
`prefetch` fills the persistent Hugging Face cache with exactly the files the engine requests at
runtime (ControlNet, SDPose-OOD, preprocessors, SDXL configs); cached files are not downloaded again.
Tokens (HF_TOKEN, CIVITAI_TOKEN) are read from the environment and never printed.
"""
import argparse
import os
import re
import shutil
import struct
import sys
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from launcher import Config, LaunchError  # noqa: E402

FOLDERS = {'checkpoint': 'checkpoints', 'lora': 'loras', 'vae': 'vae'}
NAME_RE = re.compile(r'^[\w .()+\-\[\]]{1,200}\.safetensors$')
MARGIN = 2 * 2**30
UNKNOWN_SIZE_MIN_FREE = 12 * 2**30

# Repositories and file names exactly as requested by engine/inference/{controlnet,sdpose,text2img}.py.
HF_SETS = {
    # from_single_file(config='stabilityai/stable-diffusion-xl-base-1.0') and AutoencoderKL.load_config: configs only.
    'sdxl-config': [('stabilityai/stable-diffusion-xl-base-1.0', ['**/*.json', '*.json', '*.txt', '**/*.txt', '**/*.model'])],
    'controlnet': [('xinsir/controlnet-openpose-sdxl-1.0', ['config.json', 'diffusion_pytorch_model.safetensors']),
                   ('diffusers/controlnet-canny-sdxl-1.0', ['config.json', 'diffusion_pytorch_model.fp16.safetensors']),
                   ('diffusers/controlnet-depth-sdxl-1.0-small', ['config.json', 'diffusion_pytorch_model.fp16.safetensors'])],
    'annotators': [('lllyasviel/Annotators', ['body_pose_model.pth'])],
    'depth': [('depth-anything/Depth-Anything-V2-Small-hf', ['config.json', 'preprocessor_config.json', 'model.safetensors'])],
    'sdpose': [(os.environ.get('YOISAKI_SDPOSE_REPO', 'teemosliang/SDPose-Body'),
                ['unet/config.json', 'unet/diffusion_pytorch_model.safetensors', 'vae/config.json',
                 'vae/diffusion_pytorch_model.safetensors', 'decoder/decoder.safetensors'])],
}


class FetchError(RuntimeError):
    pass


def gb(n):
    return f'{n / 2**30:.2f} ГБ'


def ensure_space(folder, needed):
    free = shutil.disk_usage(folder).free
    if free < needed:
        raise FetchError(f'Недостаточно места: нужно {gb(needed)}, свободно {gb(free)}. Ничего не загружено.')


def safe_name(name):
    name = Path(urllib.parse.unquote(name or '')).name.strip()
    if not NAME_RE.match(name):
        raise FetchError('Имя файла должно оканчиваться на .safetensors и содержать только буквы, цифры, пробел и ._-()+[]. Укажите --name.')
    return name


def target_dir(cfg, kind):
    folder = cfg.models / FOLDERS[kind]
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def validate(path, kind, cfg):
    """Engine catalogue check (worker.models.inspect): header must parse and match the kind."""
    sys.path.insert(0, str(cfg.engine))
    try:
        from worker.models import inspect, header
        _arch, ok, _meta = inspect(path, kind)
        # The catalogue checks architecture, not payload completeness. A valid header can
        # survive a truncated transfer (especially when Content-Length is unavailable).
        tensors = [v for k, v in header(path).items() if k != '__metadata__']
        ends = []
        for tensor in tensors:
            offsets = tensor.get('data_offsets') if isinstance(tensor, dict) else None
            if (not isinstance(offsets, list) or len(offsets) != 2
                    or any(type(n) is not int for n in offsets) or not 0 <= offsets[0] <= offsets[1]):
                raise ValueError('Неверные границы данных тензора')
            ends.append(offsets[1])
        with path.open('rb') as f:
            header_bytes = struct.unpack('<Q', f.read(8))[0]
        if path.stat().st_size != 8 + header_bytes + max(ends, default=0):
            raise ValueError('Размер данных не совпадает с заголовком safetensors')
    except (ValueError, OSError) as exc:
        raise FetchError(f'Файл не является корректным safetensors ({exc}).')
    finally:
        sys.path.remove(str(cfg.engine))
    if ok is False:
        raise FetchError('Файл не прошёл проверку совместимости SDXL для этого типа модели.')


def finish(part, final, kind, cfg):
    try:
        validate(part, kind, cfg)
    except FetchError:
        bad = final.with_name(final.name + '.invalid')
        os.replace(part, bad)
        raise FetchError(f'Загруженный файл не прошёл проверку и сохранён как {bad.name} (в каталог моделей не добавлен).')
    if final.exists():  # appeared meanwhile: never overwrite
        raise FetchError(f'{final.name} уже существует; новая копия оставлена в {part.name}.')
    os.replace(part, final)
    print(f'Готово: {final} ({gb(final.stat().st_size)})')


def open_url(url, start=0):
    req = urllib.request.Request(url, headers={'User-Agent': 'YOISAKI-ENGINE-CloudCompute'})
    host = urllib.parse.urlsplit(url).hostname or ''
    token = (os.environ.get('CIVITAI_TOKEN') if host == 'civitai.com' or host.endswith('.civitai.com')
             else os.environ.get('HF_TOKEN') if host == 'huggingface.co' or host.endswith('.huggingface.co') else None)
    if token:
        # Unredirected: the token is not forwarded to the CDN host the download redirects to.
        req.add_unredirected_header('Authorization', 'Bearer ' + token)
    if start:
        req.add_header('Range', f'bytes={start}-')
    return urllib.request.urlopen(req, timeout=60)


def filename_from(response, url):
    disposition = response.headers.get('Content-Disposition', '')
    match = re.search(r"filename\*=UTF-8''([^;]+)", disposition) or re.search(r'filename="?([^";]+)"?', disposition)
    return match.group(1) if match else urllib.parse.urlsplit(url).path.rsplit('/', 1)[-1]


def fetch_url(cfg, url, kind, name=None):
    if urllib.parse.urlsplit(url).scheme != 'https':
        raise FetchError('Поддерживаются только ссылки https://')
    folder = target_dir(cfg, kind)
    if name:
        name = safe_name(name)
    else:
        with open_url(url) as probe:  # headers only: the file name from Content-Disposition / URL
            name = safe_name(filename_from(probe, url))
    final = folder / name
    if final.exists():
        print(f'Уже есть: {final} — повторная загрузка не нужна.')
        return final
    part = folder / (name + '.part')
    start = part.stat().st_size if part.exists() else 0
    with open_url(url, start) as response:
        resumed = bool(start) and response.status == 206
        if not resumed:
            start = 0
        length = response.headers.get('Content-Length')
        remaining = int(length) if length and length.isdigit() else None
        ensure_space(folder, (remaining + MARGIN) if remaining is not None else UNKNOWN_SIZE_MIN_FREE)
        total = remaining + start if remaining is not None else None
        print(f'Загрузка {name} → {folder}' + (f' ({gb(total)})' if total else '') + (f', продолжение с {gb(start)}' if resumed else ''))
        done, reported = start, start
        with part.open('ab' if resumed else 'wb') as f:
            while chunk := response.read(4 * 2**20):
                f.write(chunk)
                done += len(chunk)
                if done - reported >= 512 * 2**20:
                    reported = done
                    print(f'  {gb(done)}' + (f' из {gb(total)}' if total else ''), flush=True)
    if total is not None and part.stat().st_size != total:
        raise FetchError(f'Загрузка прервана ({gb(part.stat().st_size)} из {gb(total)}). Повторите ту же команду — она продолжится.')
    finish(part, final, kind, cfg)
    return final


def fetch_gdrive(cfg, link, kind, name):
    name = safe_name(name)
    folder = target_dir(cfg, kind)
    final = folder / name
    if final.exists():
        print(f'Уже есть: {final} — повторная загрузка не нужна.')
        return final
    ensure_space(folder, UNKNOWN_SIZE_MIN_FREE)
    try:
        import gdown
    except ImportError:
        raise FetchError('gdown не установлен в среде движка.')
    part = folder / (name + '.part')
    match = re.search(r'/d/([\w-]{20,})', link) or re.search(r'[?&]id=([\w-]{20,})', link)
    file_id = match.group(1) if match else link if re.fullmatch(r'[\w-]{20,}', link) else None
    if not file_id:
        raise FetchError('Не удалось распознать ссылку Google Drive. Нужна ссылка вида https://drive.google.com/file/d/<ID>/view')
    print(f'Загрузка из Google Drive → {final} (файл должен быть доступен «всем, у кого есть ссылка»)')
    if gdown.download(id=file_id, output=str(part), quiet=False, resume=True) is None:
        raise FetchError('Google Drive не отдал файл (нет доступа по ссылке или превышен лимит скачиваний). Повторите позже.')
    finish(part, final, kind, cfg)
    return final


def prefetch(only):
    try:
        from huggingface_hub import HfApi, snapshot_download
        from huggingface_hub.utils import filter_repo_objects
    except ImportError:
        raise FetchError('huggingface_hub не установлен в среде движка.')
    cache = os.environ.get('HF_HOME')
    print(f'Кэш Hugging Face: {cache}')
    api = HfApi()
    for group in only:
        for repo, patterns in HF_SETS[group]:
            if Path(repo).is_dir():
                print(f'[{group}] {repo}: локальная папка, загрузка не нужна.')
                continue
            try:
                info = api.model_info(repo, files_metadata=True)
                files = {s.rfilename: s.size or 0 for s in info.siblings}
                wanted = list(filter_repo_objects(list(files), allow_patterns=patterns))
                missing = [p for p in patterns if '*' not in p and p not in files]
                need = sum(files[f] for f in wanted)
            except Exception as exc:
                raise FetchError(f'[{group}] {repo}: Hugging Face недоступен ({type(exc).__name__}). Кэш не изменён.')
            Path(cache).mkdir(parents=True, exist_ok=True)
            ensure_space(cache, need + MARGIN)  # upper bound; already cached files are skipped
            print(f'[{group}] {repo}: {len(wanted)} файл(ов), до {gb(need)}' + (f'; в репозитории нет {missing} — движок выберет другой формат при первом использовании' if missing else ''))
            snapshot_download(repo, allow_patterns=patterns)
    print('Prefetch завершён. Повторный запуск ничего не загружает, если файлы уже в кэше.')


def list_models(cfg):
    sys.path.insert(0, str(cfg.engine))
    from worker.models import scan
    rows = scan(cfg.models)
    if not rows:
        print(f'Моделей нет в {cfg.models}')
    for row in rows:
        size = gb(row['size_bytes']) if row.get('size_bytes') else '—'
        print(f"{row['kind']:<10} {row['architecture']:<20} {size:>10}  {row['name']}")


def main(argv):
    parser = argparse.ArgumentParser(prog='fetch-models-cloudcompute.sh', description='Загрузка моделей YOISAKI на CloudCompute')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('list')
    for name in ('url', 'gdrive'):
        p = sub.add_parser(name)
        p.add_argument('source')
        p.add_argument('--kind', required=True, choices=sorted(FOLDERS))
        p.add_argument('--name', required=name == 'gdrive')
    p = sub.add_parser('prefetch')
    p.add_argument('--only', default=','.join(HF_SETS))
    args = parser.parse_args(argv[1:])
    try:
        cfg = Config()
        if args.command == 'list':
            list_models(cfg)
        elif args.command == 'url':
            fetch_url(cfg, args.source, args.kind, args.name)
        elif args.command == 'gdrive':
            fetch_gdrive(cfg, args.source, args.kind, args.name)
        else:
            groups = [g.strip() for g in args.only.split(',') if g.strip()]
            unknown = [g for g in groups if g not in HF_SETS]
            if unknown:
                raise FetchError(f'Неизвестные группы: {unknown}. Доступны: {", ".join(HF_SETS)}')
            prefetch(groups)
        return 0
    except (FetchError, LaunchError) as exc:
        print('ОШИБКА: ' + str(exc), file=sys.stderr)
        return 1
    except OSError as exc:
        print(f'ОШИБКА сети или диска: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    os.umask(0o022)  # `docker exec` may start with umask 000: never create world-writable files
    sys.exit(main(sys.argv))
