"""Authenticated /sync/* routes added to the unchanged engine app on CloudCompute (never on Colab).

The routes take no paths, remotes or commands from the client: the source folder and the target catalogue are
fixed by the server configuration. Every route requires the engine Bearer token (same check as the engine).
Responses never contain the OAuth token, rclone.conf content, Drive file IDs or absolute server paths.
"""
import hmac

import json

from fastapi import Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from drive_sync import SyncError

STATUS = {'BUSY': 409, 'NOT_CONFIGURED': 409, 'READ_ONLY': 409, 'DISABLED': 503, 'RCLONE_MISSING': 503,
          'INVALID': 422, 'INVALID_TOKEN': 422, 'INVALID_CLIENT': 422}


class ConnectRequest(BaseModel):
    model_config = {'extra': 'forbid'}
    token: str = Field(min_length=20, max_length=12000)
    client_id: str = Field(default='', max_length=200)
    client_secret: str = Field(default='', max_length=200)


def add_routes(app, token, service):
    def guard(authorization: str = Header(default='')):
        if not hmac.compare_digest(authorization.encode(), ('Bearer ' + token).encode()):
            raise HTTPException(401, 'Invalid engine access token')
    auth = [Depends(guard)]

    def call(fn, *args):
        try:
            return fn(*args)
        except SyncError as exc:
            return JSONResponse({'detail': str(exc), 'code': exc.code}, status_code=STATUS.get(exc.code, 409),
                                headers={'Cache-Control': 'no-store'})

    app.add_api_route('/sync/status', lambda: call(service.status), methods=['GET'], dependencies=auth)
    app.add_api_route('/sync/check', lambda: call(service.start, 'check'), methods=['POST'], dependencies=auth)
    async def start(request: Request):
        # 1.7.3: only an optional {"paths": [...]} selection from /sync/check is read; every other field is ignored
        # (as before 1.7.3), so no path, remote or command can reach the server. Paths only select among listed items.
        try:
            data = json.loads(await request.body() or b'{}')
        except ValueError:
            data = {}
        paths = data.get('paths') if isinstance(data, dict) else None
        return call(service.start, 'sync', paths)
    app.add_api_route('/sync/start', start, methods=['POST'], dependencies=auth)
    app.add_api_route('/sync/cancel', lambda: call(service.cancel), methods=['POST'], dependencies=auth)

    def connect(data: ConnectRequest):
        return call(service.connect, data.token, data.client_id.strip(), data.client_secret.strip())
    app.add_api_route('/sync/drive/connect', connect, methods=['POST'], dependencies=auth)
    app.add_api_route('/sync/drive/disconnect', lambda: call(service.disconnect), methods=['POST'], dependencies=auth)
    return app
