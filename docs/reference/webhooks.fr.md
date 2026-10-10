# Webhooks

[Read in English](webhooks.md)

Tutoriel : [recevoir les changements par webhook](../tutorials/webhooks.fr.md), avec des récepteurs en Node et en
Python.

## Une livraison

```http
POST <votre adresse>
Content-Type: application/json
User-Agent: filarr-gate-webhook
Filarr-Gate-Event: row.updated
Filarr-Gate-Delivery: dlv_…
Filarr-Gate-Signature: t=<secondes unix>,v1=<hex>
```

`v1 = HMAC-SHA256(secret, t + "." + corps brut)`, en hexadécimal. Vérifiez-la sur les **octets bruts** du corps, avant
de le lire, avec une comparaison en temps constant, et refusez un `t` à plus de 300 secondes de votre horloge.

## Les événements

| événement | part quand | corps (en plus de `id` et `event`) |
|---|---|---|
| `row.created` | une ligne apparaît dans la base (ou la vue) et passe la condition | `base`, `view`?, `version`, `origin`, `row` |
| `row.updated` | une ligne change et passe la condition (avec « devient vraie » : seulement quand elle ne la passait pas avant) | les mêmes, plus `changed` (noms des champs) et `before` (leurs anciennes valeurs) |
| `row.deleted` | une ligne est supprimée | `base`, `view`?, `version`, `origin`, `row` (telle qu'elle était) |
| `gate.quota` | Filarr prévient à 80 % et à 100 % d'une limite | `name`, `pct`, `at` |
| `ping` | **Envoyer un essai** | `webhook`, `at` |
| `file.filed` | un fichier déposé par cette boîte noire a été rangé par l'appli Filarr (pas envoyé pour `rejected` ni `expired`) | `file: { id, depositId, status, depositedAt, filedAt, sizeBytes, source }` |
| `sync.done`, `sync.failed` | un passage d'une synchro externe s'est terminé : `sync.done` quand son état est `ok`, `sync.failed` sinon (une erreur, un garde-fou, une synchro bloquée) | `defId`, `name`, `base`, `state`, `code`, `counts`, `queue`, `at` |

`origin` vaut `filarr` (écrit dans Filarr) ou `gate` (écrit par cette boîte noire). `id` est l'identifiant de la
livraison, le même à chaque nouvel essai : servez-vous-en pour ignorer une livraison déjà traitée.

L'interface de gestion et son API proposent `row.created`, `row.updated`, `row.deleted` et `gate.quota`. `file.filed`,
`sync.done` et `sync.failed` ne sont livrés qu'aux webhooks qui les portent, c'est-à-dire aujourd'hui aux webhooks
importés avec un paquet de réglages.

## Ce que sélectionne un webhook

| réglage | |
|---|---|
| base, vue | les lignes de cette base ; avec une vue, seulement celles que ses filtres gardent |
| condition | du SQL sur les champs JSON de la ligne, évalué par le moteur SQL de Filarr (`montant > 1000 AND statut = 'Client'`) ; une ligne sur laquelle elle échoue ne passe pas |
| devient vraie | pour `row.updated` : seulement quand la ligne passe maintenant et ne passait pas avant |
| champs | les champs envoyés (`id` toujours) ; vide : toute la ligne |
| relations à résoudre | les champs de relation dont les lignes liées sont envoyées entières (quand leur base est ouverte à l'accès) |

## Les nouveaux essais

- Une réussite est un `2xx` en moins de 10 secondes. Les redirections ne sont pas suivies.
- 8 essais : tout de suite, puis au bout de 5, 10, 20, 40, 80, 160 et 320 minutes (environ dix heures et demie en
  tout) ; un `Retry-After` plus long du récepteur est respecté. Ensuite la livraison est abandonnée, et le journal le
  dit.
- Les livraisons en attente ne vivent qu'en mémoire : un redémarrage les abandonne (le journal dit combien).
- Les 200 dernières livraisons de chaque webhook (statut, durée, essai, erreur, prochain essai) sont sur l'écran
  **Webhooks** ; leurs corps restent en mémoire.

## Les secrets

Montré une fois à la création (`whsec_…`) ; **renouveler** en montre un nouveau, et l'ancien cesse de signer tout de
suite. Les secrets sont gardés dans l'état de la boîte noire (ils voyagent dans un paquet de réglages, pour que les
récepteurs continuent de vérifier après une migration).
