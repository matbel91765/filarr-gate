# Appeler l'API : curl, JavaScript, Python

[Read in English](first-calls.md)

**À la fin**, vous saurez lister des lignes avec des filtres, un tri et des pages, lire une vue, exécuter du SQL,
créer, modifier et supprimer une ligne sans risque, et traiter un refus et un `429`, dans les trois langages côte à
côte. Chaque bloc ci-dessous est recopié d'[examples/first-calls](../../examples/first-calls), que la suite d'essais
exécute contre une boîte noire avant chaque version : ce que vous copiez est ce qui a tourné. Les commentaires des
extraits restent donc en anglais ; le texte autour dit ce que fait chacun.

**Palier :** la lecture est offerte à tous les paliers. L'écriture demande un palier qui comprend l'écriture par l'API
(Solo et plus). Les lectures servies par la boîte noire ne sont jamais comptées par Filarr.

## Avant de commencer

- Une boîte noire en marche ([sur votre ordinateur](install-local.fr.md)). Pour suivre à l'identique, prenez les bases
  de démonstration de `npm run mock-filarr` : une base `clients` (champs `nom`, `ville`, `statut`, `ca`,
  `dernier_contact`…) avec les vues `tous-les-clients`, `clients-actifs`, `a-relancer`.
- Une **clé d'application** pour votre programme. Ces exemples demandent : la lecture de `clients`, le droit SQL, et
  l'ajout, la modification et la suppression dans `clients`. Créez-la dans l'interface de gestion (**Clés des
  applications › Nouvelle clé** : cochez la base avec Lire, Ajouter, Modifier, Supprimer, et le SQL). L'écriture
  demande aussi le réglage `write` de la boîte noire (`FILARR_GATE_WRITE=true`).
- Deux variables pour chaque exemple :

```sh
export FILARR_GATE_URL=http://127.0.0.1:8443
export FILARR_GATE_KEY=gk_…
```

Lancez les exemples en entier : `bash examples/first-calls/calls.sh`, `node examples/first-calls/calls.mjs`,
`python examples/first-calls/calls.py` (Python 3.10 ou plus récent, bibliothèque standard seulement).

## Un petit client

Chaque appel porte la clé (`Authorization: Bearer gk_…`). Les versions JavaScript et Python l'enveloppent dans une
fonction qui transforme aussi un refus en erreur portant son `code`, et attend `Retry-After` sur un `429`. curl obtient
la même chose avec `--retry 3`.

JavaScript (Node 20+, Deno, Bun) :

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

Python :

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

## Lister des lignes : filtrer, trier, choisir les champs, paginer

`GET /v1/<base>` prend :

| paramètre | exemple | |
|---|---|---|
| `champ=valeur` | `statut=Client` | égal (les textes se comparent sans casse ni accents) |
| `champ[op]=valeur` | `ca[gte]=1000` | `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `contains`, `in` (valeurs séparées par des virgules), `empty` (`true` ou `false`) |
| `sort` | `-ca,nom` | un `-` trie par ordre décroissant ; les valeurs vides viennent en dernier |
| `fields` | `nom,ville` | les champs à rendre (`id` toujours) |
| `q` | `acme` | recherche rapide dans le texte, comme dans Filarr |
| `limit`, `cursor` | `limit=2`, `cursor=o2` | 100 lignes par défaut, 1000 au plus ; passez le `next` de la réponse comme `cursor` |
| `since` | `since=1042` | seulement les lignes changées après cette version |

curl (`-g` empêche curl de lire les crochets de `ca[gte]` comme un motif). L'exemple cherche les clients dont le
chiffre d'affaires atteint 1000, du plus gros au plus petit, deux par page, trois champs ; la réponse finit par
`"next":"o2"`, à passer en `cursor=o2` pour la page suivante :

<!-- snippet: examples/first-calls/calls.sh#list -->
```sh
# Customers with a turnover of 1000 or more, largest first, two per page, three fields
curl -sS -g --retry 3 -H "Authorization: Bearer $FILARR_GATE_KEY" \
  "$FILARR_GATE_URL/v1/clients?ca[gte]=1000&sort=-ca&fields=nom,ville,ca&limit=2"
# The answer ends with "next":"o2": pass it as cursor=o2 for the next page
curl -sS -g --retry 3 -H "Authorization: Bearer $FILARR_GATE_KEY" \
  "$FILARR_GATE_URL/v1/clients?ca[gte]=1000&sort=-ca&fields=nom,ville,ca&limit=2&cursor=o2"
```

JavaScript, qui suit les pages jusqu'à ce que `next` soit vide :

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

Python (`urlencode` écrit les crochets en `%5B…%5D`, que la boîte noire lit de la même façon) :

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

La réponse :

```json
{"rows":[{"id":"r_acme","nom":"Acme","ville":"Lyon","ca":12500},{"id":"r_globex","nom":"Globex","ville":"Nantes","ca":9800}],"next":"o2","total":3,"version":12}
```

`total` compte les lignes qui correspondent, toutes pages confondues ; `version` est la version de la base servie
(passez-la en `since` la fois suivante pour n'obtenir que ce qui a changé).

## Lire une vue

`GET /v1/<base>/<vue>` rejoue une vue de Filarr avec le moteur de vues de Filarr lui-même : ses filtres, son tri, ses
colonnes visibles. Les paramètres de la liste s'appliquent aussi, après les filtres propres à la vue.

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

Une vue est un confort, pas une frontière : une clé d'application qui lit la base lit toutes les colonnes. Pour ne
donner à un programme qu'une vue, créez une clé limitée à cette vue.

## Exécuter du SQL

`POST /v1/sql` exécute une requête en lecture seule (dialecte SQLite) avec le moteur SQL de Filarr, sur les bases que
la clé peut lire. Les tables sont celles de la vue Requête de Filarr : une par base, nommée d'après son **titre**
(minuscules, sans accents, `_` entre les mots : « Clients de la boutique » devient `clients_de_la_boutique`), une
colonne par colonne, nommée de la même façon (colonnes calculées laissées de côté) ; une relation simple est une clé
étrangère `<relation>_id` (la relation « Client » de « Commandes » est `commandes.client_id`), une relation multiple
une table de liaison. L'**Explorateur SQL** de l'interface de gestion liste chaque table et chaque colonne. La clé a
besoin du droit SQL.

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

La réponse est `{ "columns": [...], "rows": [[...], ...], "ms", "scanned", "truncated" }`. Une requête que vous lancez
souvent peut s'enregistrer dans l'interface de gestion (**Explorateur SQL › Enregistrer comme point d'accès**) et
s'appeler à `GET /v1/q/<slug>`, les lignes en objets, avec `limit` et `cursor`.

## Créer, modifier, supprimer

- `POST /v1/<base>` avec un objet crée une ligne, avec un tableau (500 au plus) en crée plusieurs : dans les deux cas,
  une seule validation dans Filarr. Les colonnes que vous omettez reçoivent leur valeur par défaut, comme le fait
  « Nouvelle ligne » dans Filarr.
- `PATCH /v1/<base>/rows/<id>` change les champs donnés ; `null` vide un champ.
- `DELETE /v1/<base>/rows/<id>` supprime la ligne (elle se restaure dans Filarr).
- Les champs de sélection prennent le libellé d'une option (`"statut": "Client"`) ; les champs de relation, une liste
  d'identifiants de lignes.
- **`Idempotency-Key`** : donnez n'importe quelle chaîne unique. Si la même requête revient avec la même clé (après un
  délai dépassé, une nouvelle tentative), la boîte noire rend de nouveau le premier résultat, avec
  `Idempotency-Replayed: true`, et n'écrit rien deux fois. Elle s'en souvient 24 heures, en mémoire.

Chaque exemple crée une ligne avec une `Idempotency-Key` (envoyée deux fois, la ligne ne s'écrit qu'une fois), garde
son identifiant, change un seul champ (les autres restent tels quels), puis la supprime :

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

La réponse à la création :

```json
{"id":"db-1760070000000-1ce0x5n8kq","row":{"id":"db-1760070000000-1ce0x5n8kq","nom":"Hooli","ville":"Bordeaux","statut":"Prospect","ca":4200, …},"version":13,"validated":true}
```

`validated: true` veut dire que Filarr a accepté la validation. La nouvelle ligne est dans Filarr, visible des membres
de la base, en quelques secondes.

## Refus et limites

Un refus est du JSON avec un `code` stable (et des détails comme `field`) : fiez-vous au code, jamais au message.

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

Un `429` porte `Retry-After` (en secondes) : `key_rate` est la limite propre à la clé d'application, par minute
(réglée sur la clé) ; `api_rate` ou `api_quota_writes` viennent des limites de Filarr pour le compte. Les clients
ci-dessus attendent et recommencent. Tous les codes : [reference/errors.fr.md](../reference/errors.fr.md).

## Générer un client typé

Chaque boîte noire se décrit à `/openapi.json` (OpenAPI 3.1) : chaque base, chaque champ avec son type, chaque vue et
chaque requête enregistrée. Donnez-la à un générateur :

```sh
curl -s http://127.0.0.1:8443/openapi.json -o filarr-gate.json
npx openapi-typescript filarr-gate.json -o filarr-gate.d.ts     # par exemple, des types TypeScript
```

La description des routes communes à toutes les boîtes noires est dans
[docs/openapi/filarr-gate.v1.json](../openapi/filarr-gate.v1.json).

## Et ensuite

- [Recevoir les changements par webhook](webhooks.fr.md) au lieu de relever.
- [La bibliothèque](library.fr.md) : la même chose, dans votre programme Node, sans serveur HTTP.
- Tout ce que fait l'API : [reference/api.fr.md](../reference/api.fr.md).
