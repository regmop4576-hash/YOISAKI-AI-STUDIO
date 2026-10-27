"""CloudCompute 1.7.3: optional publication of the current Quick Tunnel address (YOISAKI_RENDEZVOUS=ntfy).

A Quick Tunnel gets a new *.trycloudflare.com name on every start. With a persistent engine token the website can
find the new name by itself: the launcher posts {url, ts, sig} to an ntfy topic derived from the token.
  topic = 'yoisaki-' + HMAC-SHA256(token, 'yoisaki-rendezvous-topic-v1')[:40]   (unguessable without the token)
  sig   = HMAC-SHA256(token, 'yoisaki-rendezvous-v1\\n' + url + '\\n' + ts)      (forged records are ignored)
The engine token itself is never sent. Must stay byte-compatible with server/rendezvous.mjs.
Stdlib only.
"""
import hashlib
import hmac
import json
import re
import time
import urllib.request

HOST_RE = re.compile(r'^[a-z0-9.-]{3,253}$')


def _mac(token, text):
    return hmac.new(bytes.fromhex(token), text.encode(), hashlib.sha256).hexdigest()


def topic_for(token):
    return 'yoisaki-' + _mac(token, 'yoisaki-rendezvous-topic-v1')[:40]


def sign(token, url, ts):
    return _mac(token, f'yoisaki-rendezvous-v1\n{url}\n{ts}')


def record(token, url, ts=None):
    ts = int(time.time()) if ts is None else ts
    return {'v': 1, 'url': url, 'ts': ts, 'sig': sign(token, url, ts)}


def publish(token, url, host='ntfy.sh', timeout=10, opener=urllib.request.urlopen):
    if not HOST_RE.match(host):
        raise ValueError('YOISAKI_RENDEZVOUS_HOST: недопустимое имя сервера')
    body = json.dumps(record(token, url), separators=(',', ':')).encode()
    req = urllib.request.Request(f'https://{host}/{topic_for(token)}', data=body, method='POST',
                                 headers={'Content-Type': 'text/plain; charset=utf-8', 'Cache': 'yes'})
    with opener(req, timeout=timeout) as r:
        return 200 <= r.status < 300
