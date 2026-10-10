# Call the API: curl, JavaScript, Python

**At the end** you will list rows with filters, a sort and pages, read a view, run SQL, create, change and delete a
row safely, and handle a refusal and a `429`, in the three languages side by side. Every block below is copied from
[examples/first-calls](../../examples/first-calls), which the test suite runs against a gate before each release:
what you copy is what ran.

**Plan:** reading is offered on every plan. Writing needs a plan with API writes (Solo and above). Reads served by the
gate are never counted by Filarr.

## Before you start

- A running gate ([on your computer](install-local.md)). To follow along exactly, use the demo databases of
  `npm run mock-filarr`: a database `clients` (fields `nom`, `ville`, `statut`, `ca`, `dernier_contact`…) with the
  views `tous-les-clients`, `clients-actifs`, `a-relancer`.
- An **app key** for your program. These examples need: read on `clients`, the SQL right, and create, update and
  delete on `clients`. Create it in the management UI (**App keys › New key**: tick the database with Read, Create,
  Update, Delete, and SQL). Writes also need the gate's `write` setting (`FILARR_GATE_WRITE=true`).
- Two variables for every example:

```sh
export FILARR_GATE_URL=http://127.0.0.1:8443
export FILARR_GATE_KEY=gk_…
```

Run them whole: `bash examples/first-calls/calls.sh`, `node examples/first-calls/calls.mjs`,
`python examples/first-calls/calls.py` (Python 3.10 or newer, standard library only).

## A small client

Every call carries the key (`Authorization: Bearer gk_…`). The JavaScript and Python versions wrap that in one
function that also turns a refusal into an error carrying its `code`, and waits for `Retry-After` on a `429`. curl
gets the same with `--retry 3`.

JavaScript (Node 20+, Deno, Bun):

<!-- snippet: examples/first-calls/calls.mjs#client -->
```js
/** One call to the gate: JSON in and out, the `code` of a refusal kept, `Retry-After` honoured. */
async function gate(method, path, { body, headers = {}, retries = 3 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(new URL(path, GATE), {
      method,
      headers: {
        Authorization: `Bearer ${KEY}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 429 && attempt < retries) {
      const wait = Number(res.headers.get('retry-after') ?? '1');
      console.log(`429: waiting ${wait} s before trying again`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      continue;
    }
    const data = await res.json();
    if (!res.ok) {
      throw Object.assign(new Error(`${res.status} ${data.code}: ${data.error}`), { status: res.status, code: data.code, data });
    }
    return { data, headers: res.headers };
  }
}
```

Python:

<!-- snippet: examples/first-calls/calls.py#client -->
```python
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
```

## List rows: filter, sort, choose fields, paginate

`GET /v1/<database>` takes:

| parameter | example | |
|---|---|---|
| `field=value` | `statut=Client` | equals (texts compare without case or accents) |
| `field[op]=value` | `ca[gte]=1000` | `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `contains`, `in` (values separated by commas), `empty` (`true` or `false`) |
| `sort` | `-ca,nom` | a `-` sorts in descending order; empty values come last |
| `fields` | `nom,ville` | the fields to return (`id` always) |
| `q` | `acme` | quick search in the text, as in Filarr |
| `limit`, `cursor` | `limit=2`, `cursor=o2` | 100 rows by default, 1000 at most; pass the answer's `next` as `cursor` |
| `since` | `since=1042` | only the rows changed after this version |

curl (`-g` keeps the brackets of `ca[gte]` from being read as a curl pattern):

<!-- snippet: examples/first-calls/calls.sh#list -->
```sh
# Customers with a turnover of 1000 or more, largest first, two per page, three fields
curl -sS -g --retry 3 -H "Authorization: Bearer $FILARR_GATE_KEY" \
  "$FILARR_GATE_URL/v1/clients?ca[gte]=1000&sort=-ca&fields=nom,ville,ca&limit=2"
# The answer ends with "next":"o2": pass it as cursor=o2 for the next page
curl -sS -g --retry 3 -H "Authorization: Bearer $FILARR_GATE_KEY" \
  "$FILARR_GATE_URL/v1/clients?ca[gte]=1000&sort=-ca&fields=nom,ville,ca&limit=2&cursor=o2"
```

JavaScript:

<!-- snippet: examples/first-calls/calls.mjs#list -->
```js
// Customers with a turnover of 1000 or more, largest first, two per page, three fields
const query = 'ca[gte]=1000&sort=-ca&fields=nom,ville,ca&limit=2';
let page = (await gate('GET', `/v1/clients?${query}`)).data;
console.log(`${page.total} customers match (version ${page.version})`);
for (;;) {
  for (const row of page.rows) console.log(`  ${row.nom} (${row.ville}): ${row.ca}`);
  if (!page.next) break;
  page = (await gate('GET', `/v1/clients?${query}&cursor=${page.next}`)).data;
}
```

Python (`urlencode` writes the brackets as `%5B…%5D`, which the gate reads the same):

<!-- snippet: examples/first-calls/calls.py#list -->
```python
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
```

The answer:

```json
{"rows":[{"id":"r_acme","nom":"Acme","ville":"Lyon","ca":12500},{"id":"r_globex","nom":"Globex","ville":"Nantes","ca":9800}],"next":"o2","total":3,"version":12}
```

`total` counts the rows that match, all pages together; `version` is the version of the database served (pass it as
`since` next time to get only what changed).

## Read a view

`GET /v1/<database>/<view>` replays a view of Filarr with Filarr's own view engine: its filters, its sort, its visible
columns. The parameters of the list apply too, after the view's own filters.

<!-- snippet: examples/first-calls/calls.sh#view -->
```sh
# A view of Filarr, replayed by Filarr's own view engine: its filters, sort and columns
curl -sS -g --retry 3 -H "Authorization: Bearer $FILARR_GATE_KEY" \
  "$FILARR_GATE_URL/v1/clients/clients-actifs"
```

<!-- snippet: examples/first-calls/calls.mjs#view -->
```js
// A view of Filarr, replayed by Filarr's own view engine: its filters, sort and columns
const view = (await gate('GET', '/v1/clients/clients-actifs')).data;
console.log(`view "${view.view.name}": ${view.rows.map((r) => r.nom).join(', ')}`);
```

<!-- snippet: examples/first-calls/calls.py#view -->
```python
# A view of Filarr, replayed by Filarr's own view engine: its filters, sort and columns
view, _ = gate("GET", "/v1/clients/clients-actifs")
print(f"view \"{view['view']['name']}\": {', '.join(r['nom'] for r in view['rows'])}")
```

A view is a convenience, not a boundary: an app key that reads the database reads every column. To give a program
only a view, create a key limited to that view.

## Run SQL

`POST /v1/sql` runs a read-only query (SQLite dialect) with Filarr's SQL engine over the databases the key can read.
The tables are those of Filarr's Query view: one per database, named after its **title** (lower case, no accents, `_`
between words: "Clients de la boutique" is `clients_de_la_boutique`), one column per column, named the same way
(computed columns left out); a single relation is a foreign key `<relation>_id` (the relation "Client" of
"Commandes" is `commandes.client_id`), a multiple relation a junction table. The management UI's **SQL explorer**
lists every table and column. The key needs the SQL right.

<!-- snippet: examples/first-calls/calls.sh#sql -->
```sh
# Read-only SQL (SQLite dialect) over the databases the key can read
curl -sS -g --retry 3 -X POST \
  -H "Authorization: Bearer $FILARR_GATE_KEY" -H "Content-Type: application/json" \
  -d '{"sql": "SELECT ville, count(*) AS n FROM clients GROUP BY ville ORDER BY ville"}' \
  "$FILARR_GATE_URL/v1/sql"
```

<!-- snippet: examples/first-calls/calls.mjs#sql -->
```js
// Read-only SQL (SQLite dialect) over the databases the key can read
const sql = (await gate('POST', '/v1/sql', { body: { sql: 'SELECT ville, count(*) AS n FROM clients GROUP BY ville ORDER BY ville' } })).data;
console.log(`per city: ${sql.rows.map(([ville, n]) => `${ville}=${n}`).join(' ')}`);
```

<!-- snippet: examples/first-calls/calls.py#sql -->
```python
# Read-only SQL (SQLite dialect) over the databases the key can read
result, _ = gate("POST", "/v1/sql", {"sql": "SELECT ville, count(*) AS n FROM clients GROUP BY ville ORDER BY ville"})
print("per city: " + " ".join(f"{ville}={n}" for ville, n in result["rows"]))
```

The answer is `{ "columns": [...], "rows": [[...], ...], "ms", "scanned", "truncated" }`. A query you run often can be
saved in the management UI (**SQL explorer › Save as an endpoint**) and called at `GET /v1/q/<slug>`, rows as objects,
with `limit` and `cursor`.

## Create, change, delete

- `POST /v1/<database>` with an object creates one row, with an array (500 at most) creates several: either way, one
  commit in Filarr. The columns you leave out get their default value, as "New row" does in Filarr.
- `PATCH /v1/<database>/rows/<id>` changes the fields given; `null` empties a field.
- `DELETE /v1/<database>/rows/<id>` deletes the row (it can be restored in Filarr).
- Select fields take an option label (`"statut": "Client"`); relation fields take a list of row ids.
- **`Idempotency-Key`**: give any unique string. If the same request comes again with the same key (after a timeout,
  a retry), the gate answers the first result again, with `Idempotency-Replayed: true`, and writes nothing twice.
  The gate remembers it for 24 hours, in memory.

<!-- snippet: examples/first-calls/calls.sh#write -->
```sh
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
```

<!-- snippet: examples/first-calls/calls.mjs#write -->
```js
// Create a row. The Idempotency-Key makes a retry safe: the second call writes nothing.
const idempotencyKey = randomUUID();
const newCustomer = { nom: 'Hooli', ville: 'Bordeaux', ca: 4200 };
const created = await gate('POST', '/v1/clients', { body: newCustomer, headers: { 'Idempotency-Key': idempotencyKey } });
const replay = await gate('POST', '/v1/clients', { body: newCustomer, headers: { 'Idempotency-Key': idempotencyKey } });
const id = created.data.id;
console.log(`created ${created.data.row.nom}, status ${created.data.row.statut} (the column's default), id ${id.slice(0, 3)}…`);
console.log(`sent again with the same Idempotency-Key: replayed=${replay.headers.get('idempotency-replayed')}, same id: ${replay.data.id === id}`);

// Change one field (the others are left as they are), then delete the row
const updated = (await gate('PATCH', `/v1/clients/rows/${id}`, { body: { statut: 'Client' } })).data;
console.log(`updated: statut=${updated.row.statut}`);
await gate('DELETE', `/v1/clients/rows/${id}`);
console.log('deleted');
```

<!-- snippet: examples/first-calls/calls.py#write -->
```python
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
```

The answer to the creation:

```json
{"id":"db-1760070000000-1ce0x5n8kq","row":{"id":"db-1760070000000-1ce0x5n8kq","nom":"Hooli","ville":"Bordeaux","statut":"Prospect","ca":4200, …},"version":13,"validated":true}
```

`validated: true` means Filarr accepted the commit. The new row is in Filarr, visible to the members of the database,
within seconds.

## Refusals and limits

A refusal is JSON with a stable `code` (and details such as `field`): match on the code, never on the message.

<!-- snippet: examples/first-calls/calls.sh#errors -->
```sh
# A refusal carries a stable "code" (and details): -w prints the HTTP status after the body
curl -sS -g -w ' HTTP %{http_code}\n' -H "Authorization: Bearer $FILARR_GATE_KEY" \
  "$FILARR_GATE_URL/v1/clients?couleur=bleu"
```

<!-- snippet: examples/first-calls/calls.mjs#errors -->
```js
// A refusal carries a stable `code` (and details): match on it, not on the message
try {
  await gate('GET', '/v1/clients?couleur=bleu');
} catch (err) {
  console.log(`refused: ${err.status} ${err.code} (field: ${err.data.field})`);
}
```

<!-- snippet: examples/first-calls/calls.py#errors -->
```python
# A refusal carries a stable `code` (and details): match on it, not on the message
try:
    gate("GET", "/v1/clients?couleur=bleu")
except GateError as error:
    print(f"refused: {error.status} {error.code} (field: {error.data.get('field')})")
```

```text
{"error":"Champ inconnu : couleur","code":"unknown_field","field":"couleur"} HTTP 400
```

A `429` carries `Retry-After` (seconds): `key_rate` is the app key's own limit per minute (set on the key); `api_rate`
or `api_quota_writes` come from Filarr's limits for the account. The clients above wait and try again. Every code:
[reference/errors.md](../reference/errors.md).

## Generate a typed client

Each gate describes itself at `/openapi.json` (OpenAPI 3.1): every database, every field with its type, every view
and saved query. Feed it to a generator:

```sh
curl -s http://127.0.0.1:8443/openapi.json -o filarr-gate.json
npx openapi-typescript filarr-gate.json -o filarr-gate.d.ts     # for example, TypeScript types
```

The description of the routes common to every gate is in [docs/openapi/filarr-gate.v1.json](../openapi/filarr-gate.v1.json).

## Next

- [Receive changes by webhook](webhooks.md) instead of polling.
- [The library](library.md): the same, inside your Node program, without an HTTP server.
- Everything the API does: [reference/api.md](../reference/api.md).
