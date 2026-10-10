# Le service hébergé, et comment le vérifier vous-même

[Read in English](hosted.md)

> Bientôt : la boîte hébergée par Filarr n'est pas ouverte. Cette page dit ce qui sera vérifiable, et ce que ce dépôt
> ne fournit pas encore. Ce que Filarr peut voir dans ce mode, et ce qui le protège :
> [sécurité et confiance](../security-and-trust.fr.md#hébergée-par-filarr). L'aller et le retour :
> [le tutoriel](../tutorials/hosted-and-back.fr.md).

## Le même code

Le service hébergé fait tourner le code de ce dépôt public : le cœur de la boîte noire (`packages/server`) par son
adaptateur Cloudflare (`packages/cloudflare`), un Durable Object par accès hébergé, dans la juridiction UE. Il ajoute
ce que seul le service a : ouvrir le jeton scellé avec sa propre clé, signer ses requêtes à l'API de Filarr, le canal de
gestion signé qu'emploient les applis de Filarr (pas d'interface de gestion), les reçus d'effacement.

## Ce qu'annonce une boîte hébergée

`https://<nom>.gate.filarr.com/.well-known/filarr-gate-host.json` :

```json
{ "version": "…", "codeHash": "sha256:…", "buildRef": "…", "deployedAt": "…", "keyId": "h1", "sig": "…" }
```

signé par la clé du service (`HOST_SIG`), dont la clé publique est inscrite dans les applis de Filarr, publiée par
Filarr à `GET /public/gate-host` (et par ce dépôt dans `docs/hosted-keys.json`, quand le service ouvrira). À chaque
mise en service, le service l'écrit aussi au journal de chaque accès hébergé ; les applis de Filarr comparent
`codeHash` à la version publiée et disent « la même que la version publiée » ou, en rouge, « différente de la version
publiée ».

**Ce que cela prouve, et ce que cela ne prouve pas.** Cela prouve que le service **annonce** le code d'une version
publiée. Aucune attestation à distance n'existe sur Cloudflare Workers : personne, Filarr compris, ne peut vous prouver
que le code qui tourne est le code annoncé. C'est pourquoi les versions n'entrent en service que depuis une étiquette
signée, sept jours après leur publication (sauf un correctif de sécurité, journalisé comme tel), pourquoi un journal
public les liste, et pourquoi une revue de sécurité externe précède l'ouverture du service.

## Vérifier une version vous-même

Ce qui existe aujourd'hui : les paquets npm de la bibliothèque et de la commande se construisent de façon
reproductible. Depuis un clone, à l'étiquette de la version :

```sh
npm ci
node scripts/pack-check.mjs release     # construit et empaquette deux fois, compare, écrit release/SHA256SUMS
```

puis comparez `release/SHA256SUMS` au `SHA256SUMS` de la version publiée sur GitHub ([release.fr.md](../release.fr.md)).

Ce qui n'existe pas encore dans ce dépôt : la construction du paquet propre au service hébergé et le calcul de son
`codeHash`, pour que chacun puisse reconstruire l'empreinte exacte qu'annonce une boîte hébergée. Ils doivent arriver
avec le service, avant son ouverture ; d'ici là, la vérification ci-dessus couvre les paquets, pas le service hébergé.

## Partir

Reprendre la clé pour revenir à une boîte noire à vous transfère les clés d'application, les webhooks et les requêtes
enregistrées avec le paquet de réglages, bascule l'identité, efface la copie hébergée avec un reçu signé, et change les
clés des bases : voyez [le tutoriel](../tutorials/hosted-and-back.fr.md#revenir-chez-vous).
