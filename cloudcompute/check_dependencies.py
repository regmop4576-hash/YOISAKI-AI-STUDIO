"""Read-only pin check before reusing a preinstalled Python. Never upgrades the host."""
import importlib.metadata
import sys
from pathlib import Path

try:
    from packaging.requirements import Requirement
except ImportError:
    from pip._vendor.packaging.requirements import Requirement


def missing(requirements, version=importlib.metadata.version):
    problems = []
    for text in requirements:
        for line in text.splitlines():
            line = line.split('#', 1)[0].strip()
            if not line:
                continue
            req = Requirement(line)
            if req.marker and not req.marker.evaluate():
                continue
            try:
                installed = version(req.name)
            except importlib.metadata.PackageNotFoundError:
                problems.append(req.name + ': missing')
                continue
            if installed not in req.specifier:
                problems.append(f'{req.name}: {installed} does not match {req.specifier}')
    return problems


if __name__ == '__main__':
    errors = missing([Path(p).read_text() for p in sys.argv[1:]])
    print('\n'.join(errors) if errors else 'DEPENDENCIES_REUSABLE')
    sys.exit(bool(errors))
