"""A nightly CSV export of a Filarr database through Filarr Gate, with Python's standard library.

    FILARR_GATE_URL=http://127.0.0.1:8443 FILARR_GATE_KEY=gk_... python export.py [out.csv]

The app key needs the SQL right and read on the databases the query names. Schedule it with
cron (`0 2 * * * cd /opt/export && python export.py`) or the Windows Task Scheduler.
Reads are served by the gate from its copy: they are never counted by Filarr.
"""

import csv
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request

GATE = os.environ.get("FILARR_GATE_URL", "http://127.0.0.1:8443")
KEY = os.environ.get("FILARR_GATE_KEY") or sys.exit("Set FILARR_GATE_KEY to an app key (gk_...)")
OUT = sys.argv[1] if len(sys.argv) > 1 else f"clients-{datetime.date.today().isoformat()}.csv"

# region query
# Each customer with its number of orders and its turnover. Tables and columns are named as in
# Filarr's Query view; the single relation "Client" of "Commandes" is `commandes.client_id`.
QUERY = """
SELECT c.nom, c.ville, count(o.id) AS commandes, coalesce(sum(o.montant), 0) AS chiffre
FROM clients AS c LEFT JOIN commandes AS o ON o.client_id = c.id
GROUP BY c.id, c.nom, c.ville
ORDER BY chiffre DESC, c.nom
"""
# endregion


# region run
def run_sql(sql: str, retries: int = 5) -> dict:
    request = urllib.request.Request(
        GATE.rstrip("/") + "/v1/sql",
        data=json.dumps({"sql": sql}).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    )
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(request) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            body = json.load(error)
            if error.code == 429 and attempt < retries:
                time.sleep(int(error.headers.get("Retry-After", "1")))
                continue
            sys.exit(f"export refused: {error.code} {body.get('code')}: {body.get('error')}")


result = run_sql(QUERY)
if result["truncated"]:
    print("warning: the result was cut; export in several queries", file=sys.stderr)
with open(OUT, "w", newline="", encoding="utf-8") as f:
    writer = csv.writer(f)
    writer.writerow(result["columns"])
    writer.writerows(result["rows"])
print(f"{len(result['rows'])} rows written to {OUT} in {result['ms']} ms")
# endregion
