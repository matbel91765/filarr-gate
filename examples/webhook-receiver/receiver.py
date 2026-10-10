"""A webhook receiver for Filarr Gate, with Python's standard library only: it checks the
signature on the RAW body, refuses an old timestamp, then acts on the event.

    WEBHOOK_SECRET=whsec_... PORT=8000 python receiver.py

Give the gate the address http://<this machine>:8000/filarr when you create the webhook
(management UI, Webhooks screen); it shows the signing secret once.
"""

import hashlib
import hmac
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

SECRET = os.environ.get("WEBHOOK_SECRET")
if not SECRET:
    raise SystemExit("Set WEBHOOK_SECRET to the secret the gate showed (whsec_...)")


# region verify
def verify_signature(secret: str, raw_body: bytes, header: str, now: int | None = None) -> bool:
    """True when `header` (`Filarr-Gate-Signature: t=<seconds>,v1=<hex>`) signs `raw_body`
    with `secret`, less than 5 minutes ago: v1 = HMAC-SHA256(secret, t + "." + body)."""
    parts = dict(p.strip().split("=", 1) for p in (header or "").split(",") if "=" in p)
    try:
        t = int(parts.get("t", ""))
    except ValueError:
        return False
    if abs((now if now is not None else int(time.time())) - t) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))
# endregion


# region handle
def handle(event: dict) -> None:
    """What to do with each event (here: one line on the console)."""
    kind = event["event"]
    if kind in ("row.created", "row.deleted"):
        print(f"{kind} {event['base']} {event['row']['id']}")
    elif kind == "row.updated":
        print(f"{kind} {event['base']} {event['row']['id']} changed: {', '.join(event['changed'])}")
    else:
        print(kind)
    sys.stdout.flush()
# endregion


class Receiver(BaseHTTPRequestHandler):
    def do_POST(self):
        # The signature covers the bytes as sent: verify BEFORE parsing
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if not verify_signature(SECRET, raw, self.headers.get("Filarr-Gate-Signature", "")):
            print("refused: bad signature", flush=True)
            self.send_response(401)
            self.end_headers()
            return
        # Answer quickly (2xx within 10 s), work afterwards; the gate retries on any other answer
        self.send_response(204)
        self.end_headers()
        handle(json.loads(raw))

    def log_message(self, *args):  # keep the console for the events
        pass


if __name__ == "__main__":
    host, port = os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "8000"))
    server = HTTPServer((host, port), Receiver)
    print(f"listening on http://{host}:{server.server_address[1]}/filarr", flush=True)
    server.serve_forever()
