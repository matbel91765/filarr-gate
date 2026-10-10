# Recevoir les changements par webhook

[Read in English](webhooks.md)

**À la fin**, quand une ligne change dans Filarr (ou par l'API), la boîte noire la déchiffre et l'envoie, signée, à
votre logiciel ; votre récepteur vérifie la signature et agit. Vous aurez un récepteur en Node et un en Python, un
webhook qui ne part que quand une condition devient vraie, et vous saurez ce qui se passe quand votre récepteur est
arrêté.

**Palier :** tous les paliers. Les changements arrivent à la boîte noire en direct à partir de Solo, au rythme de la
relève en Free ; le webhook part dès que la boîte noire voit le changement. Les lignes vont de la boîte noire à votre
récepteur, jamais par Filarr.

## 1. Démarrer un récepteur

Les deux récepteurs vérifient la signature sur le corps BRUT, refusent un horodatage décalé de plus de cinq minutes,
répondent `204` tout de suite, puis agissent. Ils sont dans [examples/webhook-receiver](../../examples/webhook-receiver)
; la suite d'essais lance chacun, fait un changement dans Filarr, vérifie que la livraison est traitée, puis en envoie
une contrefaite et vérifie qu'elle est refusée.

La vérification de la signature, en Node (la fonction renvoie vrai quand l'en-tête `Filarr-Gate-Signature`,
`t=<secondes>,v1=<hex>`, signe le corps brut avec le secret et date de moins de 5 minutes : `v1 = HMAC-SHA256(secret, t
+ "." + corps)`) :

<!-- snippet: examples/webhook-receiver/receiver.mjs#verify -->
```js
/**
 * True when `header` (the `Filarr-Gate-Signature` header, `t=<seconds>,v1=<hex>`) signs
 * `rawBody` with `secret`, less than 5 minutes ago: v1 = HMAC-SHA256(secret, t + "." + body).
 */
function verifySignature(secret, rawBody, header, now = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries(String(header ?? '').split(',').map((p) => p.trim().split('=', 2)));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(now - t) > 300) return false;
  if (!/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(parts.v1, 'hex'));
}
```

en Python :

<!-- snippet: examples/webhook-receiver/receiver.py#verify -->
```python
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
```

Ce que chacun fait d'un événement (ici, une ligne sur la console) :

<!-- snippet: examples/webhook-receiver/receiver.mjs#handle -->
```js
/** What to do with each event (here: one line on the console). */
function handle(event) {
  switch (event.event) {
    case 'row.created':
    case 'row.deleted':
      console.log(`${event.event} ${event.base} ${event.row.id}`);
      break;
    case 'row.updated':
      console.log(`${event.event} ${event.base} ${event.row.id} changed: ${event.changed.join(', ')}`);
      break;
    default:
      console.log(`${event.event}`);
  }
}
```

Démarrez-en un (le secret vient à l'étape suivante ; redémarrez-le alors) :

```sh
WEBHOOK_SECRET=whsec_… PORT=8000 node examples/webhook-receiver/receiver.mjs
WEBHOOK_SECRET=whsec_… PORT=8000 python examples/webhook-receiver/receiver.py
```

La boîte noire doit le joindre : depuis un conteneur Docker, `localhost` est le conteneur lui-même ; donnez une adresse
que la machine de la boîte noire peut joindre (en production, en HTTPS).

## 2. Créer le webhook

Dans l'interface de gestion, **Webhooks › Nouveau webhook** :

- **Nom** : à quoi il sert (« Facturation : nouvelle commande »).
- **Adresse appelée** : ici `http://127.0.0.1:8000/filarr`.
- **Événements** : Ligne ajoutée (`row.created`), Ligne modifiée (`row.updated`), Ligne supprimée (`row.deleted`),
  Avis de quota de Filarr (`gate.quota`).
- **Base**, et éventuellement une **Vue** : seules les lignes de cette vue le déclenchent.
- **Condition** (facultative) : du SQL sur les champs JSON de la ligne, évalué par le moteur SQL de Filarr :
  `statut = 'Perdu'`, `montant > 1000`, `ville IN ('Lyon', 'Paris')`.
- **Seulement quand la condition DEVIENT vraie** : pour `row.updated`, le webhook part quand la ligne entre dans la
  condition, pas à chaque changement suivant (« statut devient Perdu »).
- **Champs envoyés** (vide : toute la ligne), et **Relations à résoudre** : un champ de relation porte alors les lignes
  liées elles-mêmes (quand leur base est ouverte à l'accès), pas seulement leurs identifiants.

**Créer le webhook** montre le **secret de signature** (`whsec_…`) une seule fois : donnez-le à votre récepteur
(`WEBHOOK_SECRET`) et redémarrez-le. **Envoyer un essai** envoie tout de suite un événement `ping`.

## 3. Regarder une livraison

Changez une ligne de cette base dans Filarr. Le récepteur affiche :

```text
row.updated clients r_initech changed: ville
```

La requête qu'il a reçue :

```http
POST /filarr HTTP/1.1
Content-Type: application/json
User-Agent: filarr-gate-webhook
Filarr-Gate-Event: row.updated
Filarr-Gate-Delivery: dlv_mgk2z1a4e3f9c2b71d
Filarr-Gate-Signature: t=1760074123,v1=5d41402abc4b2a76b9719d911017c592…

{"id":"dlv_mgk2z1a4e3f9c2b71d","event":"row.updated","base":"clients","version":15,"origin":"filarr",
 "changed":["ville"],"before":{"ville":"Lille"},"row":{"id":"r_initech","nom":"Initech","ville":"Roubaix", …}}
```

| champ | |
|---|---|
| `id` | l'identifiant de la livraison, le même à chaque nouvel essai : servez-vous-en pour ignorer une livraison déjà traitée |
| `event` | `row.created`, `row.updated`, `row.deleted`, `gate.quota`, `ping` (et `file.filed`, `sync.done`, `sync.failed` : plus bas) |
| `base`, `view` | les slugs |
| `version` | la version de la base après le changement |
| `origin` | `filarr` (écrit dans Filarr) ou `gate` (écrit par l'API de cette boîte noire) |
| `changed`, `before` | `row.updated` seulement : les champs qui ont changé, et leurs valeurs d'avant |
| `row` | la ligne, telle que l'API la donne (seulement les champs envoyés) |

`gate.quota` porte `{ name, pct, at }` quand Filarr prévient à 80 % et à 100 % d'une limite.

## Quand le récepteur est arrêté

- Tout ce qui n'est pas un `2xx` en moins de **10 secondes** est un échec (les redirections ne sont pas suivies).
- La boîte noire essaie **8 fois** : tout de suite, puis au bout de 5, 10, 20, 40, 80, 160 et 320 minutes, environ dix
  heures et demie en tout ; un `Retry-After` plus long de votre récepteur est respecté. Ensuite elle abandonne, et le
  journal le dit.
- Les livraisons en attente vivent **en mémoire seulement** (leurs corps portent des lignes en clair) : un redémarrage
  de la boîte noire les abandonne, et le journal dit combien. Pour une copie fiable, faites de temps en temps un
  rapprochement avec `GET /v1/<base>?since=<version>`.
- L'écran **Webhooks** montre les dernières livraisons de chaque webhook : statut, durée, essai, prochain essai.

## Changer le secret

**Renouveler** le secret (sur le webhook) en montre un nouveau ; l'ancien cesse de signer tout de suite. Donnez le
nouveau au récepteur sans attendre.

## Les événements des fichiers et des synchros

La boîte noire envoie aussi `file.filed` (un fichier déposé par cette boîte noire a été rangé par l'appli Filarr :
`file: { id, status, depositedAt, filedAt, sizeBytes, source }`, jamais où ni sous quel nom) et `sync.done` /
`sync.failed` (un passage d'une synchro externe : `defId`, `name`, `base`, `state`, `code`, `counts`, `queue`).
L'interface de gestion ne permet pas encore de choisir ces événements : seuls les webhooks qui les portent (importés du
paquet de réglages d'une autre boîte noire) les reçoivent.

## Et ensuite

- [Un site statique reconstruit à chaque changement](../../examples/static-site) (webhook et reconstruction).
- La signature, les nouveaux essais, chaque événement : [reference/webhooks.fr.md](../reference/webhooks.fr.md).

## Si ça ne marche pas

- Rien n'arrive : l'écran **Webhooks** montre chaque essai et son erreur (`fetch failed` : l'adresse n'est pas
  joignable depuis la boîte noire).
- Votre récepteur refuse chaque livraison : calculez le HMAC sur les octets bruts, avant toute lecture du JSON ;
  comparez `t + "." + corps` ; vérifiez l'horloge de la machine.
- Plus de cas : [dépannage](../troubleshooting.fr.md#les-webhooks-narrivent-pas).
