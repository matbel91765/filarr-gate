#!/usr/bin/env bash
# Deposit a file into Filarr through Filarr Gate, with curl, then follow its status.
#
#   FILARR_GATE_URL=http://127.0.0.1:8443 FILARR_GATE_KEY=gk_… bash deposit.sh facture.pdf
#
# The app key needs the `files` scope; Filarr must have linked a deposit box to the access.
set -euo pipefail
: "${FILARR_GATE_URL:=http://127.0.0.1:8443}"
: "${FILARR_GATE_KEY:?Set FILARR_GATE_KEY to an app key with the files scope (gk_…)}"
FILE="${1:?Give the path of a file to deposit}"

# region multipart
# multipart/form-data: the file, a requested path, tags (repeated or separated by commas)
curl -sS -H "Authorization: Bearer $FILARR_GATE_KEY" \
  -F "file=@$FILE;type=application/pdf" \
  -F "path=Factures/2026/10" \
  -F "tags=facture,fournisseur" \
  "$FILARR_GATE_URL/v1/files"
# endregion
echo

# region raw
# The raw bytes, the name in the query string: handy from a program that holds the bytes
ANSWER=$(curl -sS -H "Authorization: Bearer $FILARR_GATE_KEY" \
  -H "Content-Type: application/pdf" --data-binary "@$FILE" \
  "$FILARR_GATE_URL/v1/files?name=facture-0042.pdf&tags=facture")
echo "$ANSWER"
ID=$(echo "$ANSWER" | sed -E 's/^\{"id":"([^"]+)".*/\1/')
# endregion

# region status
# deposited → filed (or rejected, expired). Never where, never under which name.
curl -sS -H "Authorization: Bearer $FILARR_GATE_KEY" "$FILARR_GATE_URL/v1/files/$ID"
# endregion
echo

# region refused
# An executable is refused by the gate before anything leaves (415)
printf 'MZ\x90\x00' > not-an-invoice.pdf
curl -sS -w ' HTTP %{http_code}\n' -H "Authorization: Bearer $FILARR_GATE_KEY" \
  -F "file=@not-an-invoice.pdf" "$FILARR_GATE_URL/v1/files"
rm -f not-an-invoice.pdf
# endregion
