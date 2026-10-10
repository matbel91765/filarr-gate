"""Deposit files into Filarr through Filarr Gate, with Python's standard library, then wait
until the Filarr app files them.

    FILARR_GATE_URL=http://127.0.0.1:8443 FILARR_GATE_KEY=gk_... python deposit.py invoices/*.pdf

The app key needs the `files` scope; Filarr must have linked a deposit box to the access.
"""

import json
import mimetypes
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

GATE = os.environ.get("FILARR_GATE_URL", "http://127.0.0.1:8443").rstrip("/")
KEY = os.environ.get("FILARR_GATE_KEY") or sys.exit("Set FILARR_GATE_KEY to an app key with the files scope")
AUTH = {"Authorization": f"Bearer {KEY}"}


# region deposit
def deposit(path: pathlib.Path, folder: str, tags: list[str]) -> dict:
    """Sends the raw bytes; the name, the requested path and the tags go in the query string."""
    query = urllib.parse.urlencode({"name": path.name, "path": folder, "tags": ",".join(tags)})
    request = urllib.request.Request(
        f"{GATE}/v1/files?{query}",
        data=path.read_bytes(),
        method="POST",
        headers={**AUTH, "Content-Type": mimetypes.guess_type(path.name)[0] or "application/octet-stream"},
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request) as response:
                return json.load(response)  # 202 {"id": "dp_...", "status": "deposited", ...}
        except urllib.error.HTTPError as error:
            body = json.load(error)
            if error.code == 429 and attempt < 3:  # Filarr's quotas or rate: wait as told
                time.sleep(int(error.headers.get("Retry-After", "1")))
                continue
            raise SystemExit(f"{path.name}: refused, {error.code} {body['code']}")
# endregion


# region wait
def wait_until_filed(deposit_id: str, seconds: int = 60) -> dict:
    """Polls the status until the Filarr app has filed (or rejected) the deposit."""
    for _ in range(seconds // 2):
        with urllib.request.urlopen(urllib.request.Request(f"{GATE}/v1/files/{deposit_id}", headers=AUTH)) as response:
            status = json.load(response)
        if status["status"] != "deposited":
            return status
        time.sleep(2)
    return status
# endregion


if __name__ == "__main__":
    ids = []
    for name in sys.argv[1:]:
        out = deposit(pathlib.Path(name), "Factures/2026/10", ["facture"])
        print(f"{name}: {out['status']} as {out['id']}", flush=True)
        ids.append(out["id"])
    for deposit_id in ids:
        status = wait_until_filed(deposit_id, int(os.environ.get("WAIT_SECONDS", "60")))
        print(f"{deposit_id}: {status['status']}", flush=True)
