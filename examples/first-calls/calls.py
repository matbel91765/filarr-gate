"""First calls to the local API of Filarr Gate, with Python's standard library only.

    FILARR_GATE_URL=http://127.0.0.1:8443 FILARR_GATE_KEY=gk_... python calls.py

The app key needs: read on the "clients" database, the SQL right, and the create, update and
delete rights on "clients" (writes also need `write` switched on in the gate).
It runs against the demo databases of `npm run mock-filarr`.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

GATE = os.environ.get("FILARR_GATE_URL", "http://127.0.0.1:8443")
KEY = os.environ.get("FILARR_GATE_KEY")
if not KEY:
    raise SystemExit("Set FILARR_GATE_KEY to an app key (gk_...)")


# region client
class GateError(Exception):
    """A refusal of the gate: its HTTP status, its stable `code`, and the details."""

    def __init__(self, status, data):
        super().__init__(f"{status} {data.get('code')}: {data.get('error')}")
        self.status, self.code, self.data = status, data.get("code"), data


def gate(method, path, body=None, headers=None, retries=3):
    """One call to the gate: JSON in and out, `Retry-After` honoured on a 429."""
    url = GATE.rstrip("/") + path
    data = None if body is None else json.dumps(body).encode()
    all_headers = {"Authorization": f"Bearer {KEY}", **(headers or {})}
    if body is not None:
        all_headers["Content-Type"] = "application/json"
    for attempt in range(retries + 1):
        request = urllib.request.Request(url, data=data, method=method, headers=all_headers)
        try:
            with urllib.request.urlopen(request) as response:
                return json.load(response), response.headers
        except urllib.error.HTTPError as error:
            if error.code == 429 and attempt < retries:
                wait = int(error.headers.get("Retry-After", "1"))
                print(f"429: waiting {wait} s before trying again")
                time.sleep(wait)
                continue
            raise GateError(error.code, json.load(error)) from None
# endregion


# region list
# Customers with a turnover of 1000 or more, largest first, two per page, three fields
params = {"ca[gte]": "1000", "sort": "-ca", "fields": "nom,ville,ca", "limit": "2"}
page, _ = gate("GET", "/v1/clients?" + urllib.parse.urlencode(params))
print(f"{page['total']} customers match (version {page['version']})")
while True:
    for row in page["rows"]:
        print(f"  {row['nom']} ({row['ville']}): {row['ca']}")
    if not page["next"]:
        break
    page, _ = gate("GET", "/v1/clients?" + urllib.parse.urlencode({**params, "cursor": page["next"]}))
# endregion

# region view
# A view of Filarr, replayed by Filarr's own view engine: its filters, sort and columns
view, _ = gate("GET", "/v1/clients/clients-actifs")
print(f"view \"{view['view']['name']}\": {', '.join(r['nom'] for r in view['rows'])}")
# endregion

# region sql
# Read-only SQL (SQLite dialect) over the databases the key can read
result, _ = gate("POST", "/v1/sql", {"sql": "SELECT ville, count(*) AS n FROM clients GROUP BY ville ORDER BY ville"})
print("per city: " + " ".join(f"{ville}={n}" for ville, n in result["rows"]))
# endregion

# region write
# Create a row. The Idempotency-Key makes a retry safe: the second call writes nothing.
idempotency_key = str(uuid.uuid4())
new_customer = {"nom": "Hooli", "ville": "Bordeaux", "ca": 4200}
created, _ = gate("POST", "/v1/clients", new_customer, {"Idempotency-Key": idempotency_key})
replay, replay_headers = gate("POST", "/v1/clients", new_customer, {"Idempotency-Key": idempotency_key})
row_id = created["id"]
print(f"created {created['row']['nom']}, status {created['row']['statut']} (the column's default), id {row_id[:3]}...")
print(f"sent again with the same Idempotency-Key: replayed={replay_headers.get('Idempotency-Replayed')}, same id: {replay['id'] == row_id}")

# Change one field (the others are left as they are), then delete the row
updated, _ = gate("PATCH", f"/v1/clients/rows/{row_id}", {"statut": "Client"})
print(f"updated: statut={updated['row']['statut']}")
gate("DELETE", f"/v1/clients/rows/{row_id}")
print("deleted")
# endregion

# region errors
# A refusal carries a stable `code` (and details): match on it, not on the message
try:
    gate("GET", "/v1/clients?couleur=bleu")
except GateError as error:
    print(f"refused: {error.status} {error.code} (field: {error.data.get('field')})")
# endregion
