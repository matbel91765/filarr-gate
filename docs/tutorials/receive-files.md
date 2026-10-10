# Receive files from your software into a Filarr folder

> **Coming soon, on Filarr's side.** The gate's file slot works today: every gate-side step below is run by the test
> suite, including the refusal of an executable before anything leaves. Linking a deposit box to an access, and the
> placement rules, come with a coming version of the Filarr app, and the feature opens account by account. The
> Filarr-side steps follow the frozen contract `gate-fichiers-1`.

**At the end** your ERP posts each invoice to the gate; the gate checks it, encrypts it for your deposit box and
drops it at Filarr; your Filarr app files it in "Comptabilité › Invoices › 2026 › 10" by a rule you wrote; the ERP
learns "filed", never where. Filarr sees a sealed deposit and its size; never the name, the requested path, the tags
or the folder.

**Plan:** files through the API need Pro or above. The monthly number and volume of deposits depend on the plan:
Filarr shows them in **Settings › API access**, and the gate's **Usage and limits** screen reads them from Filarr.

## How it works

1. Your software sends a file to the gate (`POST /v1/files`) with an app key that has the **files** scope.
2. The gate **filters** it before anything leaves: executables and scripts, by their extension and by their first
   bytes (`MZ`, ELF, Mach-O, `#!`), and files that are too large, are refused (`415`, `413`). These refusals stay in
   the gate's local log.
3. The gate draws a fresh key for the file, encrypts the file in chunks and a manifest (name, type, size, SHA-256,
   requested path, tags, which app key sent it) with it, and seals that key to your **deposit box**. It only does so
   for a box **signed by the access creator**: a server that slipped in its own box would be refused.
4. Filarr stores the sealed deposit. It cannot open it.
5. A device of yours where "file automatically" is on (or "file now") opens it, checks the SHA-256, places it by your
   rules, renames it, handles duplicates, and records where. The gate learns `filed` (or `rejected`, `expired`).

It is a slot: the gate deposits, it can never list, read back or delete what is filed. A stolen token can deposit,
never read your files.

## 1. In Filarr: link a deposit box (coming soon)

When you open a database to an API, or later in **Settings › API access**, ask the access to **receive files**:
Filarr links a permanent deposit box to it (it creates "Entrées API" if you have none) and signs it. Then set where
files go:

- the **target folder** ("Comptabilité › Invoices");
- **rules**, in order, the first match wins: "PDF → `Factures/{year}/{month}`", "Images → `Photos/{year}`", by
  extension, type, tag or sending key;
- a **name pattern** (`{date}_{source}_{name}{ext}`), whether to **accept the path** the software asks for, what to do
  with **duplicates** (skip, keep both, new version), and the **fallback** sub-folder ("To sort") for what no rule
  matches.

The rules are stored encrypted in your keychain: every device files the same way. The tokens are written in English
and shown in your language (`{year}` or `{année}`). Details:
<https://filarr.com/en/docs/gate-placement-rules>.

The access needs a **creator tag**: an access created by a recent Filarr app has one; for an older one, replace its
token once.

## 2. Check from the gate

```sh
filarr-gate doctor
```

```text
ok    fichiers               boîte de dépôt liée et signée · 0 en attente de rangement
```

```sh
filarr-gate files test
```

deposits a small text file tagged `essai`: it should appear in your folder.

## 3. A key for the ERP

```sh
filarr-gate keys create --name ERP --files
```

This key also reads every view. For a key that can **only** deposit, create it in the management UI: **App keys ›
New key**, tick only "Deposit files (`POST /v1/files`)".

## 4. Send files

With curl, `multipart/form-data` (the file, a requested path, tags):

<!-- snippet: examples/receive-files/deposit.sh#multipart -->
```sh
# multipart/form-data: the file, a requested path, tags (repeated or separated by commas)
curl -sS -H "Authorization: Bearer $FILARR_GATE_KEY" \
  -F "file=@$FILE;type=application/pdf" \
  -F "path=Factures/2026/10" \
  -F "tags=facture,fournisseur" \
  "$FILARR_GATE_URL/v1/files"
```

or the raw bytes, the name in the query string:

<!-- snippet: examples/receive-files/deposit.sh#raw -->
```sh
# The raw bytes, the name in the query string: handy from a program that holds the bytes
ANSWER=$(curl -sS -H "Authorization: Bearer $FILARR_GATE_KEY" \
  -H "Content-Type: application/pdf" --data-binary "@$FILE" \
  "$FILARR_GATE_URL/v1/files?name=facture-0042.pdf&tags=facture")
echo "$ANSWER"
ID=$(echo "$ANSWER" | sed -E 's/^\{"id":"([^"]+)".*/\1/')
```

```json
{"id":"dp_ZgD1ambaYz0Mgg54","status":"deposited","depositedAt":"2026-10-10T03:33:18.935Z","seq":2}
```

`id` is the gate's id of the deposit; `seq` its number in the month for this box (the `{n}` of the name patterns).

In JavaScript (from [examples/erp-orders-invoices](../../examples/erp-orders-invoices/erp.mjs), which also writes the
day's orders in one idempotent request):

<!-- snippet: examples/erp-orders-invoices/erp.mjs#deposit -->
```js
// The invoice of the first order, as a PDF. `path` asks for a sub-folder (applied if the
// deposit box accepts requested paths); `tags` can drive the placement rules.
const pdf = new TextEncoder().encode('%PDF-1.4\n% Invoice C-2026-1190, Acme, 1890.00 EUR\n%%EOF\n');
const form = new FormData();
form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'facture-C-2026-1190.pdf');
form.append('path', 'Factures/2026/10');
form.append('tags', 'facture,acme');
const { data: deposit } = await check(await fetch(`${GATE}/v1/files`, { method: 'POST', headers: auth, body: form }));
console.log(`deposited ${deposit.id}: ${deposit.status}`);
```

In Python, standard library only ([examples/receive-files/deposit.py](../../examples/receive-files/deposit.py)):

<!-- snippet: examples/receive-files/deposit.py#deposit -->
```python
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
```

## 5. Follow the status

<!-- snippet: examples/receive-files/deposit.sh#status -->
```sh
# deposited → filed (or rejected, expired). Never where, never under which name.
curl -sS -H "Authorization: Bearer $FILARR_GATE_KEY" "$FILARR_GATE_URL/v1/files/$ID"
```

<!-- snippet: examples/receive-files/deposit.py#wait -->
```python
def wait_until_filed(deposit_id: str, seconds: int = 60) -> dict:
    """Polls the status until the Filarr app has filed (or rejected) the deposit."""
    for _ in range(seconds // 2):
        with urllib.request.urlopen(urllib.request.Request(f"{GATE}/v1/files/{deposit_id}", headers=AUTH)) as response:
            status = json.load(response)
        if status["status"] != "deposited":
            return status
        time.sleep(2)
    return status
```

| status | |
|---|---|
| `deposited` | Filarr holds it; no device has filed it yet |
| `filed` | filed (or recognised as a duplicate and left), with `filedAt` |
| `rejected` | the app refused it (the SHA-256 did not match, the manifest was unreadable) |
| `expired` | never filed within the box's retention |

Never where, never under which name: that stays with your devices. A webhook `file.filed` exists too (see
[webhooks](webhooks.md#events-of-files-and-syncs)).

## What the gate refuses, and how to change it

<!-- snippet: examples/receive-files/deposit.sh#refused -->
```sh
# An executable is refused by the gate before anything leaves (415)
printf 'MZ\x90\x00' > not-an-invoice.pdf
curl -sS -w ' HTTP %{http_code}\n' -H "Authorization: Bearer $FILARR_GATE_KEY" \
  -F "file=@not-an-invoice.pdf" "$FILARR_GATE_URL/v1/files"
rm -f not-an-invoice.pdf
```

```text
{"error":"Type de fichier refusé par la boîte noire (signature : …)","code":"file_type_refused","reason":"signature","detail":"…"} HTTP 415
```

- Refused extensions by default: see [configuration](../reference/configuration.md) (`files_deny`). Replace the list
  with `FILARR_GATE_FILES_DENY`, or allow only some with `FILARR_GATE_FILES_ALLOW=.pdf,.csv,.xlsx`.
- The executable signatures are refused whatever the lists say.
- `FILARR_GATE_FILES_MAX_BYTES` lowers the size limit (never above Filarr's).

## When nobody files

The box can hold only so many deposits waiting to be filed. When it is full, the gate refuses new ones
(`409 box_full`): **open Filarr** on a device that files the box (desktop or web). Waiting does not help. Filarr's
mobile app shows "N received files are waiting to be filed" but does not file them.

## Next

- [Revoke an access](revoke.md): the deposit box stays yours; what was deposited stays fileable.
- In Filarr's help: [receiving files](https://filarr.com/en/docs/gate-files) and [the placement rules](https://filarr.com/en/docs/gate-placement-rules).

## If it does not work

- `409 files_not_linked`: no box is linked to the access yet.
- `409 creator_unauthenticated`: replace the access token in Filarr (desktop or web), then give the new one to the gate.
- `409 box_not_signed`: link the box again from Filarr.
- `403 scope_files`: the key has no files scope.
- `429 api_quota_files`, `api_quota_file_bytes`: the month's deposits are used up; `Retry-After` gives the time to the
  1st of the month (UTC).
- More: [troubleshooting](../troubleshooting.md#files).
