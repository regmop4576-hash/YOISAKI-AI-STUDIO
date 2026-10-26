"""Lightweight CloudCompute diagnostics for YOISAKI ENGINE. Never prints tokens or links.

  diagnose.py --gpu-check   strict preflight (exit 3 when this GPU cannot run the installed PyTorch)
  diagnose.py [--json]      report: GPU, CUDA, VRAM, RAM, disk, paths, versions, engine state, timings
"""
import importlib.metadata as metadata
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from launcher import APP, VERSION, Config, LaunchError, local_status  # noqa: E402

PACKAGES = ('torch', 'torchvision', 'diffusers', 'transformers', 'accelerate', 'peft', 'huggingface-hub', 'safetensors',
            'fastapi', 'uvicorn', 'pydantic', 'controlnet-aux', 'opencv-python-headless', 'timm', 'Pillow', 'gdown')
# Engine assumptions (engine/inference/*): fp16 SDXL with model CPU offload, ~7 GB of weights in system RAM.
MIN_VRAM_MB = 11000
MIN_RAM_GB = 15
MIN_FREE_DISK_GB = 20


def gpu_info():
    info = {'torch_installed': False, 'cuda_available': False}
    try:
        import torch
    except ImportError as exc:
        info['error'] = f'PyTorch не установлен ({exc})'
        return info
    info.update(torch_installed=True, torch_version=torch.__version__, torch_cuda=torch.version.cuda,
                arch_list=compiled_arch_list(torch))
    try:
        info['cuda_available'] = torch.cuda.is_available()
        if not info['cuda_available']:
            return info
        major, minor = torch.cuda.get_device_capability(0)
        free, total = torch.cuda.mem_get_info()
        info.update(gpu_name=torch.cuda.get_device_name(0), capability=f'{major}.{minor}', sm=f'sm_{major}{minor}',
                    vram_total_mb=round(total / 2**20), vram_available_mb=round(free / 2**20), gpu_count=torch.cuda.device_count())
        info['arch_supported'] = arch_supported(major, minor, info['arch_list'])
    except Exception as exc:  # broken driver / CUDA init
        info['cuda_available'] = False
        info['error'] = f'{type(exc).__name__}: {exc}'
    return info


def compiled_arch_list(torch):
    """Architectures the wheel was built for; works without a GPU (get_arch_list() is empty then)."""
    try:
        return torch._C._cuda_getArchFlags().split()
    except (AttributeError, RuntimeError):
        return torch.cuda.get_arch_list() if hasattr(torch.cuda, 'get_arch_list') else []


def arch_supported(major, minor, arch_list):
    """Native SASS for this capability, or PTX of an equal/lower compute capability (JIT)."""
    cap = major * 10 + minor
    if f'sm_{cap}' in arch_list:
        return True
    return any(a.startswith('compute_') and a[8:].isdigit() and int(a[8:]) <= cap for a in arch_list)


def smoke_test():
    """A real fp16 kernel on the GPU: catches 'no kernel image is available' before the engine starts."""
    import torch
    a = torch.randn(512, 512, device='cuda', dtype=torch.float16)
    value = float((a @ a).float().abs().mean().item())
    torch.cuda.synchronize()
    del a
    torch.cuda.empty_cache()
    if value != value:  # NaN
        raise RuntimeError('fp16 matmul вернул NaN')
    return True


def nvidia_smi():
    if not shutil.which('nvidia-smi'):
        return None
    try:
        out = subprocess.run(['nvidia-smi', '--query-gpu=name,driver_version,memory.total,memory.used', '--format=csv,noheader,nounits'],
                             capture_output=True, text=True, timeout=20)
        return out.stdout.strip() or out.stderr.strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f'ошибка: {exc}'


def meminfo():
    try:
        rows = {k: int(v.split()[0]) * 1024 for k, v in (line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())}
        return {'ram_total_gb': round(rows['MemTotal'] / 2**30, 1), 'ram_available_gb': round(rows['MemAvailable'] / 2**30, 1),
                'swap_total_gb': round(rows.get('SwapTotal', 0) / 2**30, 1)}
    except (OSError, ValueError, KeyError):
        return {}


def cgroup_memory_limit_gb():
    for path in ('/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'):
        try:
            raw = Path(path).read_text().strip()
            if raw.isdigit() and int(raw) < 2**60:
                return round(int(raw) / 2**30, 1)
        except OSError:
            continue
    return None


def versions():
    out = {}
    for name in PACKAGES:
        try:
            out[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            out[name] = None
    return out


def engine_version(cfg):
    try:
        return re.search(r"engine_version='([^']+)'", (cfg.engine / 'worker/direct_server.py').read_text()).group(1)
    except (OSError, AttributeError):
        return None


def folder_size_gb(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return round(total / 2**30, 2)


def model_counts(cfg):
    sys.path.insert(0, str(cfg.engine))
    try:
        from worker.models import scan  # stdlib only: the same catalogue the engine serves
        rows = scan(cfg.models)
    except Exception as exc:
        return {'error': f'{type(exc).__name__}'}
    finally:
        sys.path.remove(str(cfg.engine))
    counts = {}
    for row in rows:
        key = row['kind'] + ('' if row.get('compatible') is not False else '_incompatible')
        counts[key] = counts.get(key, 0) + 1
    return counts


def last_jsonl(path, predicate=lambda row: True):
    try:
        lines = path.read_text().splitlines()[-4000:]
    except OSError:
        return None
    for line in reversed(lines):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if predicate(row):
            return row
    return None


def model_load_seconds(cfg):
    """Last real checkpoint load measured by the engine itself (memory.jsonl phases)."""
    path = cfg.diagnostics / 'memory.jsonl'
    after = last_jsonl(path, lambda r: r.get('phase') == 'after_model_load')
    if not after:
        return None
    before = last_jsonl(path, lambda r: r.get('phase') == 'before_model_load' and r.get('job_id') == after.get('job_id') and r['time_unix'] <= after['time_unix'])
    return round(after['time_unix'] - before['time_unix'], 1) if before else None


def report(cfg):
    data = {'deploy_version': VERSION, 'engine_version': engine_version(cfg), 'time_unix': time.time()}
    data['gpu'] = gpu_info()
    data['nvidia_smi'] = nvidia_smi()
    data['memory'] = meminfo()
    data['memory']['cgroup_limit_gb'] = cgroup_memory_limit_gb()
    usage = shutil.disk_usage(cfg.data) if cfg.data.exists() else None
    data['disk'] = {'free_gb': round(usage.free / 2**30, 1), 'total_gb': round(usage.total / 2**30, 1)} if usage else None
    hf = os.environ.get('HF_HOME') or str(cfg.data / 'huggingface-cache')
    data['paths'] = {'data_root': str(cfg.data), 'models': str(cfg.models), 'hf_cache': hf, 'outputs': str(cfg.data / 'outputs'),
                     'logs': str(cfg.logs), 'diagnostics': str(cfg.diagnostics), 'engine': str(cfg.engine), 'app': str(APP)}
    data['sizes_gb'] = {'models': folder_size_gb(cfg.models), 'hf_cache': folder_size_gb(hf)} if cfg.data.exists() else {}
    data['models'] = model_counts(cfg) if cfg.models.exists() else {}
    try:
        data['data_id'] = json.loads((cfg.data / '.yoisaki-data-id').read_text())
    except (OSError, ValueError):
        data['data_id'] = None
    data['versions'] = versions()
    data['python'] = sys.version.split()[0]
    data['engine_state'] = local_status(cfg)
    data['last_startup'] = last_jsonl(cfg.diagnostics / 'startup-timings.jsonl')
    data['last_model_load_seconds'] = model_load_seconds(cfg)
    return data


def warnings(data):
    out = []
    g = data['gpu']
    if not g.get('cuda_available'):
        out.append('CUDA недоступна: генерация невозможна. ' + g.get('error', ''))
    elif not g.get('arch_supported'):
        out.append(f"PyTorch {g.get('torch_version')} не содержит ядер для {g.get('sm')} ({g.get('gpu_name')}).")
    if g.get('vram_total_mb') and g['vram_total_mb'] < MIN_VRAM_MB:
        out.append(f"VRAM {g['vram_total_mb']} МБ: меньше 12 ГБ, возможны ошибки нехватки памяти.")
    ram = data['memory'].get('ram_total_gb')
    limit = data['memory'].get('cgroup_limit_gb')
    effective = min(x for x in (ram, limit) if x) if (ram or limit) else None
    if effective and effective < MIN_RAM_GB:
        out.append(f'Системной RAM {effective} ГБ: меньше 16 ГБ. CPU Offload держит веса SDXL в RAM — возможна нехватка.')
    if data['disk'] and data['disk']['free_gb'] < MIN_FREE_DISK_GB:
        out.append(f"Свободно {data['disk']['free_gb']} ГБ: меньше {MIN_FREE_DISK_GB} ГБ. Загрузка моделей может не поместиться.")
    if not data['models'].get('checkpoint'):
        out.append('В models/checkpoints нет совместимого SDXL checkpoint.')
    return out


def text(data):
    g, m, d = data['gpu'], data['memory'], data['disk']
    state = data['engine_state']
    health = state.get('health') or {}
    launcher = state.get('launcher') or {}
    timings = data.get('last_startup') or {}
    lines = [
        f"YOISAKI ENGINE · CloudCompute deployment {data['deploy_version']} · протокол движка {data['engine_version']}",
        '',
        f"GPU:            {g.get('gpu_name', 'не обнаружен')} ({g.get('sm', '—')})",
        f"CUDA:           {'доступна' if g.get('cuda_available') else 'НЕДОСТУПНА'} · PyTorch {g.get('torch_version', '—')} (CUDA {g.get('torch_cuda', '—')})",
        f"Ядра PyTorch:   {'есть для этого GPU' if g.get('arch_supported') else 'НЕТ / не проверено'} · {' '.join(g.get('arch_list', []))}",
        f"VRAM:           свободно {g.get('vram_available_mb', '—')} / всего {g.get('vram_total_mb', '—')} МБ",
        f"nvidia-smi:     {data['nvidia_smi'] or 'нет в этой среде'}",
        f"RAM:            {m.get('ram_available_gb', '—')} ГБ свободно / {m.get('ram_total_gb', '—')} ГБ всего" + (f" · лимит контейнера {m['cgroup_limit_gb']} ГБ" if m.get('cgroup_limit_gb') else ''),
        f"Диск данных:    {d['free_gb']} ГБ свободно / {d['total_gb']} ГБ" if d else 'Диск данных:    папка не создана',
        f"Папка данных:   {data['paths']['data_root']}",
        f"Модели:         {data['paths']['models']} · {data['models']} · {data['sizes_gb'].get('models', 0)} ГБ",
        f"Кэш HF:         {data['paths']['hf_cache']} · {data['sizes_gb'].get('hf_cache', 0)} ГБ",
        f"Метка данных:   создана {time.strftime('%Y-%m-%d %H:%M', time.localtime(data['data_id']['created_unix']))}" if data.get('data_id') else 'Метка данных:   нет (папка ещё не инициализирована)',
        f"Python {data['python']} · " + ' · '.join(f'{k} {v}' for k, v in data['versions'].items() if v),
        '',
        f"Движок:         {launcher.get('phase', 'не запущен')} · health: {health.get('state', '—')}",
        f"Модель в памяти: {'да' if state.get('model_loaded') else 'нет — загрузится при первой генерации' if health else '—'}",
        f"Ссылка:         {'готова (./check-cloudcompute.sh link)' if state.get('link_ready') else 'нет'}",
    ]
    if timings:
        lines.append('Последний запуск: ' + ' · '.join(f'{k[:-8]} {v} с' for k, v in timings.items() if k.endswith('_after_s')))
    if data.get('last_model_load_seconds') is not None:
        lines.append(f"Последняя загрузка checkpoint (замер движка): {data['last_model_load_seconds']} с")
    issues = warnings(data)
    lines += [''] + (['ПРЕДУПРЕЖДЕНИЯ:'] + ['  • ' + w for w in issues] if issues else ['Предупреждений нет.'])
    return '\n'.join(lines)


def gpu_check():
    info = gpu_info()
    if not info.get('cuda_available'):
        print('GPU: CUDA недоступна. ' + info.get('error', 'Проверьте, что инстанс с GPU и контейнер запущен с доступом к GPU.'))
        print('nvidia-smi: ' + str(nvidia_smi()))
        return 3
    print(f"GPU: {info['gpu_name']} · {info['sm']} · VRAM {info['vram_available_mb']}/{info['vram_total_mb']} МБ · PyTorch {info['torch_version']} CUDA {info['torch_cuda']}")
    if not info['arch_supported']:
        print(f"Несовместимо: PyTorch собран для {' '.join(info['arch_list'])}, а GPU требует {info['sm']}.")
        return 3
    try:
        smoke_test()
    except Exception as exc:
        print(f'Пробное fp16-вычисление на GPU не удалось: {type(exc).__name__}: {exc}')
        return 3
    print('Пробное fp16-вычисление на GPU: OK')
    return 0


def main(argv):
    if '--gpu-check' in argv:
        return gpu_check()
    try:
        cfg = Config()
    except LaunchError as exc:
        print(exc)
        return 2
    data = report(cfg)
    rendered = text(data)
    try:
        cfg.diagnostics.mkdir(parents=True, exist_ok=True)
        (cfg.diagnostics / 'cloudcompute-report.txt').write_text(rendered + '\n')
    except OSError:
        pass
    print(json.dumps(data, ensure_ascii=False, indent=1) if '--json' in argv else rendered)
    return 0


if __name__ == '__main__':
    os.umask(0o022)  # `docker exec` may start with umask 000: never create world-writable files
    sys.exit(main(sys.argv))
