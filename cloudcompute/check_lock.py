"""Build/test check: cloudcompute/requirements-lock.txt satisfies every top-level requirement of the image.

The image installs the lock with `pip install --require-hashes --no-deps`, which does not look at the top-level
files any more; this check keeps the two in agreement (stdlib + `packaging`, which pip itself vendors).
Usage: check_lock.py [APP_DIR]   exit 0 = consistent.
"""
import re
import sys
from pathlib import Path

try:
    from packaging.requirements import Requirement
except ImportError:  # outside the image: the copy vendored by pip
    from pip._vendor.packaging.requirements import Requirement


def canonical(name):
    return re.sub(r'[-_.]+', '-', name).lower()


def read_lock(path):
    pins = {}
    for line in path.read_text().splitlines():
        m = re.match(r'^([A-Za-z0-9._-]+)==([^\s\\]+)', line)
        if m:
            pins[canonical(m.group(1))] = m.group(2)
    return pins


def requirements(path):
    for line in path.read_text().splitlines():
        line = line.split('#', 1)[0].strip()
        if line:
            yield Requirement(line)


def problems(app):
    pins = read_lock(app / 'cloudcompute/requirements-lock.txt')
    out = []
    if sum('--hash=sha256:' in line for line in (app / 'cloudcompute/requirements-lock.txt').read_text().splitlines()) != len(pins):
        out.append('каждый пакет lock-файла должен иметь ровно один sha256')
    for source in ('cloudcompute/requirements-cloud.txt', 'engine/requirements.txt'):
        for req in requirements(app / source):
            version = pins.get(canonical(req.name))
            if version is None:
                out.append(f'{source}: {req.name} отсутствует в lock-файле')
            elif not req.specifier.contains(version, prereleases=True):
                out.append(f'{source}: {req} не выполнено (lock: {version})')
    return out


if __name__ == '__main__':
    found = problems(Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]))
    for item in found:
        print('lock:', item, file=sys.stderr)
    print('requirements-lock.txt согласован с requirements-cloud.txt и engine/requirements.txt' if not found else 'lock-файл несогласован')
    sys.exit(1 if found else 0)
