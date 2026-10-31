"""Real archive install/start/update tests. Linux Termux branch simulation, not Android.
Usage: python3 tests/release-install-smoke.py RELEASE.zip /absolute/path/to/node
Only uses temporary data and synthetic local settings; never contacts Google/GPU.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import urllib.request
import zipfile


def main():
    archive, node = map(lambda s: Path(s).resolve(), sys.argv[1:3])
    version = subprocess.check_output([str(node), '--version'], text=True).strip()
    with tempfile.TemporaryDirectory(prefix='yoisaki-termux-smoke-') as tmp:
        tmp = Path(tmp)
        with zipfile.ZipFile(archive) as z:
            assert z.testzip() is None
            z.extractall(tmp / 'clean extract')
        app = next((tmp / 'clean extract').iterdir())
        assert not (app / 'node_modules').exists()
        data = tmp / 'persistent data'
        data.mkdir()
        prefix = tmp / 'com.termux' / 'files' / 'usr'
        bin_dir = prefix / 'bin'
        bin_dir.mkdir(parents=True)
        (bin_dir / 'node').symlink_to(node)
        (bin_dir / 'bash').symlink_to(shutil.which('bash'))
        # An intact release must install/start with Node only, with no npm/network.
        for name in ('npm', 'pkg'):
            p = bin_dir / name
            p.write_text('#!/bin/sh\necho UNEXPECTED_PACKAGE_MANAGER >&2\nexit 99\n')
            p.chmod(0o755)
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            port = s.getsockname()[1]
        env = {**os.environ, 'PREFIX': str(prefix), 'PATH': str(bin_dir) + os.pathsep + os.environ['PATH'],
               'YOISAKI_DATA_DIR': str(data), 'PORT': str(port)}
        def run(*args):
            r = subprocess.run(args, cwd=app, env=env, text=True, capture_output=True, timeout=90)
            print(json.dumps({'node': version, 'command': args, 'exit': r.returncode,
                              'stdout': r.stdout, 'stderr': r.stderr}, ensure_ascii=False), flush=True)
            assert r.returncode == 0, (args, r.stdout, r.stderr)
            return r
        def get(route, local=False):
            req = urllib.request.Request(f'http://127.0.0.1:{port}' + route,
                                         headers={'X-Yoisaki-Local': '1'} if local else {})
            with urllib.request.urlopen(req, timeout=10) as r:
                assert r.status == 200
                return r.read()
        run('node', 'scripts/verify-package.mjs')
        run('node', 'scripts/build-identity.mjs')
        # Synthetic configuration and gallery marker: no real credentials or image.
        client = {'client_id': '123456789012-abcdefghijklmnop.apps.googleusercontent.com',
                  'client_secret': 'synthetic-test-client'}
        (app / 'config').mkdir(exist_ok=True)
        config = app / 'config' / 'google-desktop-client.json'
        config.write_text(json.dumps(client))
        state = {'version': 1, 'settings': None, 'models': [], 'gallery': [], 'history': [],
                 'tags': {}, 'preferences': {'installation_test': 'preserve'}}
        (data / 'state.json').write_text(json.dumps(state, separators=(',', ':')))
        secrets = {'version': 1, 'connections': {}, 'google': client, 'cloud_key': None,
                   'drive': None, 'deployment': None}
        (data / 'secrets.json').write_text(json.dumps(secrets, separators=(',', ':')))
        (data / 'images').mkdir()
        (data / 'images' / 'preserve-test.bin').write_bytes(b'gallery preservation fixture')
        protected = [config, data / 'state.json', data / 'secrets.json', data / 'images' / 'preserve-test.bin']
        before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
        try:
            run('bash', 'install.sh')
            run('bash', 'install.sh')
            run('node', 'scripts/verify-package.mjs')
            assert (app / 'start.sh').read_text().splitlines()[0] == '#!' + str(bin_dir / 'bash')
            run('./start.sh')
            assert json.loads(get('/api/session', True))['version'] == '1.9.1'
            page = get('/').decode()
            assert '1.9.1' in page
            for asset in re.findall(r'(?:src|href)="(/assets/[^\"]+)"', page):
                assert len(get(asset)) > 0
            run('bash', 'stop.sh')
            run('bash', 'update.sh', str(archive), str(app))
            assert json.loads(get('/api/session', True))['version'] == '1.9.1'
            run('node', 'scripts/verify-package.mjs')
            run('node', 'scripts/build-identity.mjs')
            assert before == {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
            assert not (app / 'node_modules').exists()
            print(json.dumps({'node': version, 'result': 'PASS', 'platform': 'linux-x64',
                              'termux_branch': 'simulated PREFIX and interpreter path',
                              'npm_and_pkg': 'blocked and never called', 'clean_install': True,
                              'repeat_install': True, 'start_http': True, 'update': True,
                              'google_and_data_preserved': True}), flush=True)
        finally:
            run('bash', 'stop.sh')

if __name__ == '__main__':
    main()
