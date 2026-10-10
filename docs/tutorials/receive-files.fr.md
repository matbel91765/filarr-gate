# Recevoir les fichiers de vos logiciels dans un dossier Filarr

[Read in English](receive-files.md)

> **Bientôt, côté Filarr.** La fente à fichiers de la boîte noire marche dès aujourd'hui : chaque étape côté boîte
> noire ci-dessous est exécutée par la suite d'essais, y compris le refus d'un exécutable avant que rien ne parte. Lier
> une boîte de dépôt à un accès, et les règles de placement, arrivent avec une prochaine version de l'appli Filarr, et
> la fonction ouvre compte par compte. Les étapes côté Filarr suivent le contrat gelé `gate-fichiers-1`.

**À la fin**, votre ERP poste chaque facture à la boîte noire ; la boîte noire la contrôle, la chiffre pour votre boîte
de dépôt et la dépose chez Filarr ; votre appli Filarr la range dans « Comptabilité › Factures › 2026 › 10 » selon une
règle que vous avez écrite ; l'ERP apprend « rangé », jamais où. Filarr voit un dépôt scellé et sa taille ; jamais le
nom, le chemin demandé, les étiquettes ni le dossier.

**Palier :** les fichiers par l'API demandent Pro ou plus. Le nombre et le volume de dépôts du mois dépendent du
palier : Filarr les affiche dans **Paramètres › Accès API**, et l'écran **Consommation et limites** de la boîte noire
les lit chez Filarr.

## Comment ça marche

1. Votre logiciel envoie un fichier à la boîte noire (`POST /v1/files`) avec une clé d'application qui a la portée
   **fichiers**.
2. La boîte noire le **filtre** avant que rien ne parte : les exécutables et les scripts, par leur extension et par
   leurs premiers octets (`MZ`, ELF, Mach-O, `#!`), et les fichiers trop lourds, sont refusés (`415`, `413`). Ces refus
   restent dans le journal local de la boîte noire.
3. La boîte noire tire une clé neuve pour le fichier, chiffre avec elle le fichier par morceaux et un manifeste (nom,
   type, taille, SHA-256, chemin demandé, étiquettes, clé d'application qui l'a envoyé), et scelle cette clé pour votre
   **boîte de dépôt**. Elle ne le fait que pour une boîte **signée par le créateur de l'accès** : un serveur qui
   glisserait sa propre boîte serait refusé.
4. Filarr garde le dépôt scellé. Il ne peut pas l'ouvrir.
5. Un de vos appareils où « ranger automatiquement » est actif (ou « Ranger maintenant ») l'ouvre, vérifie le SHA-256,
   le place selon vos règles, le renomme, traite les doublons, et note où. La boîte noire apprend `filed` (ou
   `rejected`, `expired`).

C'est une fente : la boîte noire dépose, elle ne peut jamais lister, relire ni supprimer ce qui est rangé. Un jeton
volé permet de déposer, jamais de lire vos fichiers.

## 1. Dans Filarr : lier une boîte de dépôt (bientôt)

Quand vous ouvrez une base à une API, ou plus tard dans **Paramètres › Accès API**, demandez à l'accès de **recevoir
des fichiers** : Filarr lui lie une boîte de dépôt permanente (il crée « Entrées API » si vous n'en avez aucune) et la
signe. Réglez ensuite où vont les fichiers :

- le **dossier de destination** (« Comptabilité › Factures ») ;
- des **règles**, dans l'ordre, la première qui correspond l'emporte : « PDF → `Factures/{année}/{mois}` »,
  « Images → `Photos/{année}` », par extension, type, étiquette ou clé d'envoi ;
- un **modèle de nom** (`{date}_{source}_{nom}{ext}`), s'il faut **accepter le chemin** que demande le logiciel, que
  faire des **doublons** (ignorer, garder les deux, nouvelle version), et le sous-dossier de **repli** (« À ranger »)
  pour ce qu'aucune règle ne prend.

Les règles sont rangées chiffrées dans votre trousseau : chaque appareil range de la même façon. Les mots entre
accolades des modèles sont rangés en anglais et s'affichent dans votre langue (`{year}` ou `{année}`) ; vous pouvez
les taper dans l'une ou l'autre. Le détail : <https://filarr.com/docs/gate-placement-rules>.

L'accès a besoin d'une **étiquette du créateur** : un accès créé par une appli Filarr récente en a une ; pour un plus
ancien, remplacez son jeton une fois.

## 2. Vérifier depuis la boîte noire

```sh
filarr-gate doctor
```

```text
ok    fichiers               boîte de dépôt liée et signée · 0 en attente de rangement
```

```sh
filarr-gate files test
```

dépose un petit fichier texte étiqueté `essai` : il doit apparaître dans votre dossier.

## 3. Une clé pour l'ERP

```sh
filarr-gate keys create --name ERP --files
```

Cette clé lit aussi toutes les vues. Pour une clé qui ne peut **que** déposer, créez-la dans l'interface de gestion :
**Clés des applications › Nouvelle clé**, cochez seulement « Déposer des fichiers (`POST /v1/files`) ».

## 4. Envoyer des fichiers

Avec curl, en `multipart/form-data` (le fichier, un chemin demandé, des étiquettes, répétées ou séparées par des
virgules) :

<!-- snippet: examples/receive-files/deposit.sh#multipart -->
```sh
# multipart/form-data: the file, a requested path, tags (repeated or separated by commas)
curl -sS -H "Authorization: Bearer $FILARR_GATE_KEY" \
  -F "file=@$FILE;type=application/pdf" \
  -F "path=Factures/2026/10" \
  -F "tags=facture,fournisseur" \
  "$FILARR_GATE_URL/v1/files"
```

ou les octets bruts, le nom dans la chaîne de requête (pratique depuis un programme qui tient les octets) :

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

`id` est l'identifiant du dépôt pour la boîte noire ; `seq` son numéro dans le mois pour cette boîte (le `{n}` des
modèles de nom).

En JavaScript (tiré d'[examples/erp-orders-invoices](../../examples/erp-orders-invoices/erp.mjs), qui écrit aussi les
commandes du jour en une requête idempotente) : la facture de la première commande, en PDF ; `path` demande un
sous-dossier (appliqué si la boîte de dépôt accepte les chemins demandés), `tags` peut guider les règles de placement.

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

En Python, bibliothèque standard seulement ([examples/receive-files/deposit.py](../../examples/receive-files/deposit.py)) :
les octets bruts partent, le nom, le chemin demandé et les étiquettes vont dans la chaîne de requête ; sur un `429`
(quotas ou débit de Filarr), on attend ce que dit `Retry-After`.

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

## 5. Suivre l'état

`deposited` devient `filed` (ou `rejected`, `expired`). Jamais où, jamais sous quel nom.

<!-- snippet: examples/receive-files/deposit.sh#status -->
```sh
# deposited → filed (or rejected, expired). Never where, never under which name.
curl -sS -H "Authorization: Bearer $FILARR_GATE_KEY" "$FILARR_GATE_URL/v1/files/$ID"
```

En Python, en relevant l'état jusqu'à ce que l'appli Filarr ait rangé (ou refusé) le dépôt :

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

| état | |
|---|---|
| `deposited` | Filarr le garde ; aucun appareil ne l'a encore rangé |
| `filed` | rangé (ou reconnu comme doublon et laissé), avec `filedAt` |
| `rejected` | l'appli l'a refusé (le SHA-256 ne correspondait pas, le manifeste était illisible) |
| `expired` | jamais rangé pendant la durée de conservation de la boîte |

Jamais où, jamais sous quel nom : cela reste à vos appareils. Un webhook `file.filed` existe aussi (voyez les
[webhooks](webhooks.fr.md#les-événements-des-fichiers-et-des-synchros)).

## Ce que la boîte noire refuse, et comment le changer

Un exécutable est refusé par la boîte noire avant que rien ne parte (`415`) :

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

- Les extensions refusées d'office : voyez la [configuration](../reference/configuration.fr.md) (`files_deny`).
  Remplacez la liste par `FILARR_GATE_FILES_DENY`, ou ne permettez que certaines extensions avec
  `FILARR_GATE_FILES_ALLOW=.pdf,.csv,.xlsx`.
- Les signatures d'exécutables sont refusées quoi que disent les listes.
- `FILARR_GATE_FILES_MAX_BYTES` baisse la taille maximale (jamais au-dessus de celle de Filarr).

## Quand personne ne range

La boîte ne peut garder qu'un certain nombre de dépôts en attente de rangement. Quand elle est pleine, la boîte noire
refuse les nouveaux (`409 box_full`) : **ouvrez Filarr** sur un appareil qui range la boîte (bureau ou web). Attendre
ne suffit pas. L'appli mobile de Filarr affiche combien de fichiers reçus attendent d'être rangés, mais ne les range
pas.

## Et ensuite

- [Révoquer un accès](revoke.fr.md) : la boîte de dépôt reste à vous ; ce qui a été déposé reste rangeable.
- Dans l'aide de Filarr : [recevoir des fichiers](https://filarr.com/docs/gate-files) et
  [les règles de placement](https://filarr.com/docs/gate-placement-rules).

## Si ça ne marche pas

- `409 files_not_linked` : aucune boîte n'est encore liée à l'accès.
- `409 creator_unauthenticated` : remplacez le jeton de l'accès dans Filarr (bureau ou web), puis donnez le nouveau à
  la boîte noire.
- `409 box_not_signed` : liez de nouveau la boîte depuis Filarr.
- `403 scope_files` : la clé n'a pas la portée fichiers.
- `429 api_quota_files`, `api_quota_file_bytes` : les dépôts du mois sont épuisés ; `Retry-After` donne le temps
  jusqu'au 1er du mois (UTC).
- Plus de cas : [dépannage](../troubleshooting.fr.md#fichiers).
