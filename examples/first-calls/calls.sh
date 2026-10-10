#!/usr/bin/env bash
# First calls to the local API of Filarr Gate, with curl.
#
#   FILARR_GATE_URL=http://127.0.0.1:8443 FILARR_GATE_KEY=gk_… bash calls.sh
#
# The app key needs: read on the "clients" database, the SQL right, and the create, update
# and delete rights on "clients" (writes also need `write` switched on in the gate).
# It runs against the demo databases of `npm run mock-filarr`.
#
# Every call uses:
#   -g          brackets in the URL (ca[gte]) are a filter, not a curl glob
#   --retry 3   on a 429, curl waits for Retry-After, then tries again
set -euo pipefail
: "${FILARR_GATE_URL:=http://127.0.0.1:8443}"
: "${FILARR_GATE_KEY:?Set FILARR_GATE_KEY to an app key (gk_…)}"

echo "--- list"
# region list
# Customers with a turnover of 1000 or more, largest first, two per page, three fields
curl -sS -g --retry 3 -H "Authorization: Bearer $FILARR_GATE_KEY" \
  "$FILARR_GATE_URL/v1/clients?ca[gte]=1000&sort=-ca&fields=nom,ville,ca&limit=2"
# The answer ends with "next":"o2": pass it as cursor=o2 for the next page
curl -sS -g --retry 3 -H "Authorization: Bearer $FILARR_GATE_KEY" \
  "$FILARR_GATE_URL/v1/clients?ca[gte]=1000&sort=-ca&fields=nom,ville,ca&limit=2&cursor=o2"
# endregion
echo

echo "--- view"
# region view
# A view of Filarr, replayed by Filarr's own view engine: its filters, sort and columns
curl -sS -g --retry 3 -H "Authorization: Bearer $FILARR_GATE_KEY" \
  "$FILARR_GATE_URL/v1/clients/clients-actifs"
# endregion
echo

echo "--- sql"
# region sql
# Read-only SQL (SQLite dialect) over the databases the key can read
curl -sS -g --retry 3 -X POST \
  -H "Authorization: Bearer $FILARR_GATE_KEY" -H "Content-Type: application/json" \
  -d '{"sql": "SELECT ville, count(*) AS n FROM clients GROUP BY ville ORDER BY ville"}' \
  "$FILARR_GATE_URL/v1/sql"
# endregion
echo

echo "--- write"
# region write
# Create a row. The Idempotency-Key makes a retry safe: sent twice, the row is written once.
CREATED=$(curl -sS -g --retry 3 -X POST \
  -H "Authorization: Bearer $FILARR_GATE_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: crm-import-2026-10-10-hooli" \
  -d '{"nom": "Hooli", "ville": "Bordeaux", "ca": 4200}' \
  "$FILARR_GATE_URL/v1/clients")
echo "$CREATED"
# The answer starts with {"id":"db-…": keep the id (with jq: ID=$(echo "$CREATED" | jq -r .id))
ID=$(echo "$CREATED" | sed -E 's/^\{"id":"([^"]+)".*/\1/')

# Change one field (the others are left as they are)
curl -sS -g --retry 3 -X PATCH \
  -H "Authorization: Bearer $FILARR_GATE_KEY" -H "Content-Type: application/json" \
  -d '{"statut": "Client"}' \
  "$FILARR_GATE_URL/v1/clients/rows/$ID"

# Delete it
curl -sS -g --retry 3 -X DELETE -H "Authorization: Bearer $FILARR_GATE_KEY" \
  "$FILARR_GATE_URL/v1/clients/rows/$ID"
# endregion
echo

echo "--- errors"
# region errors
# A refusal carries a stable "code" (and details): -w prints the HTTP status after the body
curl -sS -g -w ' HTTP %{http_code}\n' -H "Authorization: Bearer $FILARR_GATE_KEY" \
  "$FILARR_GATE_URL/v1/clients?couleur=bleu"
# endregion
