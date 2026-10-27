"""CloudCompute engine entrypoint (1.7.3): the UNCHANGED engine app (worker.direct_server.create_app, protocol 1.7.0)
plus the authenticated Google Drive sync routes and (1.7.3) GET /inventory. Colab keeps running engine/worker/serve.py
and never imports this.

Same contract as engine/worker/serve.py: 127.0.0.1 only, token from the environment, never from argv.
"""
import hmac
import os
import sys
from pathlib import Path

import uvicorn
from worker.direct_server import create_app

sys.path.insert(0, str(Path(__file__).resolve().parent))
from drive_sync import SyncConfig, SyncService  # noqa: E402
from fastapi import Depends, Header, HTTPException  # noqa: E402
import inventory  # noqa: E402
from sync_api import add_routes  # noqa: E402


def build(model_root, token, environ=None):
    app = create_app(model_root, token)
    cfg = SyncConfig(environ)
    # One catalogue only: the sync target must be exactly the folder the engine scans.
    if Path(model_root).resolve() != cfg.models.resolve():
        raise SystemExit('YOISAKI_MODEL_ROOT и папка моделей синхронизации различаются: синхронизация не запущена.')
    def guard(authorization: str = Header(default='')):
        if not hmac.compare_digest(authorization.encode(), ('Bearer ' + token).encode()):
            raise HTTPException(401, 'Invalid engine access token')
    inventory.add_routes(app, [Depends(guard)], model_root)
    return add_routes(app, token, SyncService(cfg))


if __name__ == '__main__':
    # 1.7.3: started by hand (outside launcher.py) this used to end in KeyError: 'YOISAKI_MODEL_ROOT'.
    missing = [k for k in ('YOISAKI_MODEL_ROOT', 'YOISAKI_TOKEN') if not os.environ.get(k)]
    if missing:
        sys.exit('Этот файл запускает только лаунчер: он сам задаёт ' + ', '.join(missing) + ', PYTHONPATH, порт и туннель.\n'
                 'Запуск: ./start-cloudcompute.sh   ·   Состояние: ./check-cloudcompute.sh')
    uvicorn.run(build(os.environ['YOISAKI_MODEL_ROOT'], os.environ['YOISAKI_TOKEN']),
                host='127.0.0.1', port=int(os.environ.get('YOISAKI_PORT', '8765')), access_log=False, log_level='warning')
