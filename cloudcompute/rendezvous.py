"""CloudCompute 1.7.3: optional publication of the current Quick Tunnel address (YOISAKI_RENDEZVOUS=ntfy).

A Quick Tunnel gets a new *.trycloudflare.com name on every start. With a persistent engine token the website can
find the new name by itself: the launcher posts {url, ts, sig} to an ntfy topic derived from the token.
  topic = 'yoisaki-' + HMAC-SHA256(token, 'yoisaki-rendezvous-topic-v1')[:40]   (unguessable without the token)
  sig   = HMAC-SHA256(token, 'yoisaki-rendezvous-v1\\n' + url + '\\n' + ts)      (forged records are ignored)
The engine token itself is never sent. Must stay byte-compatible with server/rendezvous.mjs.
Stdlib only.

1.7.5: the same topic also carries signed initialization stages of an automatically provisioned instance, so the
website can show what really happened on the GPU (image started, engine starting, local server ready, failures):
  {v:1, kind:'status', stage, ts, sig}   sig = HMAC-SHA256(token, 'yoisaki-rendezvous-status-v1\n' + stage + '\n' + ts)
Status records have no url field: websites before 1.7.5 ignore them. `python3 rendezvous.py status STAGE` reads the
token from YOISAKI_TOKEN_FILE (never from argv, which other processes can see).
"""
import hashlib
import hmac
import json
import os
import re
import sys
import time
import urllib.request

HOST_RE = re.compile(r'^[a-z0-9.-]{3,253}$')
TOKEN_RE = re.compile(r'^[a-f0-9]{64}$')
# Keep in sync with STAGES in server/rendezvous.mjs.
STAGES = ('PROVISIONED', 'SUPERVISOR_STARTED', 'IMAGE_READY', 'ENGINE_STARTING', 'SERVER_READY', 'TUNNEL_RETRY', 'GPU_CHECK_FAILED', 'ENGINE_FAILED')


def _mac(token, text):
    return hmac.new(bytes.fromhex(token), text.encode(), hashlib.sha256).hexdigest()


def topic_for(token):
    return 'yoisaki-' + _mac(token, 'yoisaki-rendezvous-topic-v1')[:40]


def sign(token, url, ts):
    return _mac(token, f'yoisaki-rendezvous-v1\n{url}\n{ts}')


def record(token, url, ts=None):
    ts = int(time.time()) if ts is None else ts
    return {'v': 1, 'url': url, 'ts': ts, 'sig': sign(token, url, ts)}


def sign_status(token, stage, ts):
    return _mac(token, f'yoisaki-rendezvous-status-v1\n{stage}\n{ts}')


def status_record(token, stage, ts=None):
    if stage not in STAGES:
        raise ValueError('неизвестный этап: ' + str(stage))
    ts = int(time.time()) if ts is None else ts
    return {'v': 1, 'kind': 'status', 'stage': stage, 'ts': ts, 'sig': sign_status(token, stage, ts)}


def _post(token, body_record, host, timeout, opener):
    if not HOST_RE.match(host):
        raise ValueError('YOISAKI_RENDEZVOUS_HOST: недопустимое имя сервера')
    body = json.dumps(body_record, separators=(',', ':')).encode()
    req = urllib.request.Request(f'https://{host}/{topic_for(token)}', data=body, method='POST',
                                 headers={'Content-Type': 'text/plain; charset=utf-8', 'Cache': 'yes'})
    with opener(req, timeout=timeout) as r:
        return 200 <= r.status < 300


def publish(token, url, host='ntfy.sh', timeout=10, opener=urllib.request.urlopen):
    return _post(token, record(token, url), host, timeout, opener)


def publish_status(token, stage, host='ntfy.sh', timeout=10, opener=urllib.request.urlopen):
    return _post(token, status_record(token, stage), host, timeout, opener)


def publish_diagnostics(token, data, host='ntfy.sh', timeout=10, opener=urllib.request.urlopen):
    # Sign the exact serialized bytes: Node does not need to reproduce Python's JSON formatting.
    payload = json.dumps(data, ensure_ascii=True, separators=(',', ':'))
    ts = int(time.time())
    record = {'v': 1, 'kind': 'diagnostics', 'data': payload, 'ts': ts,
              'sig': _mac(token, f'yoisaki-rendezvous-diagnostics-v1\n{payload}\n{ts}')}
    return _post(token, record, host, timeout, opener)


def main(argv, environ=os.environ):
    """CLI for the shell autostart: `rendezvous.py status STAGE`. Exit 0 = published, 1 = not published."""
    if len(argv) != 3 or argv[1] != 'status' or argv[2] not in STAGES:
        print('Использование: rendezvous.py status ' + '|'.join(STAGES), file=sys.stderr)
        return 2
    try:
        with open(environ.get('YOISAKI_TOKEN_FILE', ''), encoding='ascii') as f:
            token = f.read().strip()
    except OSError:
        token = ''
    if not TOKEN_RE.match(token):
        print('Статус не опубликован: нет токена движка.', file=sys.stderr)
        return 1
    try:
        host = environ.get('YOISAKI_RENDEZVOUS_HOST', 'ntfy.sh').strip().lower()
        publish_status(token, argv[2], host=host)
        if argv[2] in ('PROVISIONED', 'SUPERVISOR_STARTED', 'IMAGE_READY'):
            try:
                from launcher import Config, startup_diagnostics
                publish_diagnostics(token, startup_diagnostics(Config(environ)), host=host)
            except Exception:
                pass  # optional diagnostics never invalidate a successfully published stage
        return 0
    except Exception as exc:  # optional signal: never fatal for the caller
        print(f'Статус не опубликован: {type(exc).__name__}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
