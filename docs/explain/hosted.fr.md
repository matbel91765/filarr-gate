# Le service hébergé, et comment le vérifier vous-même

[Read in English](hosted.md)

> Bientôt : la boîte hébergée par Filarr n'est pas ouverte. Son code est dans ce dépôt (`packages/host`) ; il n'entre
> en service que par la chaîne de publication, et l'offre ouvre après une revue de sécurité externe. Ce qui n'est plus
> chiffré de bout en bout dans ce mode, et ce qui le protège :
> [sécurité et confiance](../security-and-trust.fr.md#hébergée-par-filarr). L'aller et le retour :
> [le tutoriel](../tutorials/hosted-and-back.fr.md).

## Comment il est monté

| | |
|---|---|
| où il tourne | un script Worker, `filarr-gate-host`, dans le même compte Cloudflare que l'API de Filarr, **isolé par script** : ses objets durables, ses secrets, et aucune liaison vers une ressource de l'API (base, compartiments, magasin clé-valeur, ses objets, liaisons de service), ni de l'API vers lui |
| une boîte | un Durable Object par accès hébergé (`GateBox`), **créé dans la juridiction UE** : stockage et exécution de l'objet restent dans l'UE |
| adresses | la route `*.gate.filarr.com/*` de la zone `filarr.com` (un enregistrement DNS joker `*.gate` proxifié, et un certificat avancé pour `*.gate.filarr.com`, que le certificat universel de la zone ne couvre pas) |
| `<nom>.gate.filarr.com` | une boîte : son API (`/v1/…`, `/openapi.json`, `/mcp`, `/health`) et son canal de gestion signé ; un nom inconnu répond `404` |
| `ctl.gate.filarr.com` | l'adresse de contrôle, la même pour toutes les boîtes : elle reçoit les réveils de Filarr et sert l'annonce de version |
| clés | `HOST_ENC` (X25519, ouvre les jetons scellés) et `HOST_SIG` (Ed25519, signe les requêtes vers l'API, les reçus d'effacement et l'annonce de version), secrets de ce seul script ; leurs moitiés publiques sont dans [`hosted-keys.json`](../hosted-keys.json), embarqué dans le service et dans les applis de Filarr |
| journaux | aucun : le bloc `observability` est présent et éteint tout (`enabled`, journaux, journaux d'invocation, traces), avec `logpush: false`, car un bloc absent laisserait le réglage par défaut du compte ; aucun consommateur de traces (`packages/host/wrangler.jsonc`, contrôlé par un essai qui refuse une trace allumée et un bloc absent) ; la seule ligne de console est un code d'erreur d'une liste fermée |

**Ce que cet isolement garantit.** Un défaut ou une compromission du code de l'API n'atteint ni les secrets du service,
ni les objets des boîtes, ni un jeton en clair : ce code n'a aucune liaison vers eux, et l'API ne garde le jeton que
scellé vers la clé du service.

**Ce qu'il ne garantit pas, dit tel quel.** Il ne protège pas d'un administrateur du compte Cloudflare, qui peut mettre
en service un code qui lise les secrets du service ou ses objets : ce qui l'encadre est la mise en service par la seule
chaîne de publication, le journal public, la revue externe et l'engagement de Filarr, pas une barrière technique. Les
requêtes et les réponses d'une boîte hébergée ne sont pas chiffrées de bout en bout en transit : le compte qui gère
`filarr.com` termine le TLS de ces noms. Rien ne protège de Cloudflare, hébergeur.

## Ce que fait une boîte

| moment | ce qui se passe |
|---|---|
| réveil | l'API de Filarr envoie un réveil à `ctl.gate.filarr.com/_filarr/notify/<accès>`, signé par une clé propre à l'accès (aucun contenu : il dit « relis »). La boîte le vérifie, puis lit son état chez l'API par une requête signée par `HOST_SIG` |
| ouverture | la boîte lit son jeton scellé, l'ouvre avec `HOST_ENC` en mémoire, en tire ses clés, et démarre le même cœur de Filarr Gate que chez soi, par l'adaptateur Cloudflare (`packages/cloudflare`). La première clé d'application arrive dans le jeton scellé, en empreinte seulement |
| au repos | tout ce que la boîte range est chiffré sous une clé tirée du jeton (`K_box`, AES-256-GCM, chaque entrée liée à l'accès et à sa place). `K_box` n'existe qu'en mémoire : dès que l'API efface le jeton scellé, ce qui est rangé ne se déchiffre plus. Gardés en clair : l'identifiant de l'accès, le nom de la boîte, son état, la raison et la fin d'un sommeil, les bases tenues et leur génération, le compte des appels du mois, un reçu à remettre. Rien qui vienne d'une base, d'un logiciel ou d'un réglage |
| requêtes vers l'API | chacune porte, en plus de la preuve de l'accès, la signature du service (`Filarr-Gate-Host`) ; sans elle, l'API de Filarr refuse un jeton hébergé |
| gestion | aucune interface web. Les applis de Filarr règlent la boîte par `/_admin/…`, chaque requête signée par la clé d'identité du créateur (celle qu'authentifie l'étiquette du créateur de l'accès, épinglée dans l'état chiffré de la boîte) sur la méthode, le chemin **avec sa requête**, l'heure (300 s d'écart au plus) et l'empreinte du corps ; chaque requête signée est acceptée une fois (un rejeu reçoit `401 admin_replay`). Changer le jeton, un mot de passe, oublier la boîte ou importer un fichier sont fermés sur le service ; le web et le bureau de Filarr sont les seules origines admises |
| appels | les appels du mois se comptent par boîte, jusqu'au plafond du palier (`hostedCallsPerMonth` de `GET /public/api-limits`) ; au-delà, `429 hosted_quota_calls` jusqu'au 1er du mois suivant (UTC). Le total est remis à l'API de Filarr chaque heure |
| sommeil | impayé, palier plus bas, politique d'organisation, arrêt d'urgence : la boîte ne sert plus rien (`503 gate_asleep`, avec la raison), vide sa mémoire, et garde son état chiffré et son jeton scellé. Elle se réveille seule quand l'API le dit. Reprendre chez soi reste possible pendant le sommeil |
| reprendre chez soi | la boîte scelle son paquet de réglages (empreintes des clés d'application, webhooks, requêtes enregistrées, jamais un mot de passe ni une clé de base externe) vers la nouvelle identité, après avoir vérifié que le créateur l'a signée avec la clé épinglée |
| effacement | révocation, fin du sommeil, migration basculée : tout le stockage de l'objet est effacé, sa mémoire vidée, puis un **reçu signé** par `HOST_SIG` est remis à l'API de Filarr (raison et heure de la demande, telles que l'API les donne, bases et génération tenues, ce qui est effacé, version, `codeHash`). Une base retirée seule donne un reçu partiel (`withdrawn`, avec sa cause — créateur, administrateur du coffre, accord périmé — lue chez l'API ; `withdrawn` ne nomme jamais un effacement complet). Après une migration avec redirection, l'ancienne adresse répond `308` pendant 30 jours, sans lire ni garder la requête |

Le reçu prouve que le service a exécuté l'ordre. Il ne peut pas prouver qu'aucune copie n'existe ailleurs ; ce qui
s'écrit ensuite dans la base est illisible pour l'ancienne boîte, et c'est garanti par le chiffrement.

Le journal propre de la boîte (son écran « Journal » chez soi) reste dans son état, chiffré sous `K_box`, lisible par le
seul canal de gestion signé.

## Ce qu'annonce une boîte hébergée

`https://<nom>.gate.filarr.com/.well-known/filarr-gate-host.json` (et la même sur `ctl.gate.filarr.com`) :

```json
{ "version": "…", "codeHash": "sha256:…", "buildRef": "v…", "deployedAt": "…", "keyId": "h1", "sig": "…" }
```

signé par `HOST_SIG` sur `filarr/gate-host/v1|version|` suivi du JSON canonique sans `sig`. Un correctif de sécurité
ajoute `"security": true` et `"advisory": "GHSA-…"`. À chaque mise en service, le service le remet à l'API de Filarr,
qui l'écrit au journal de chaque accès hébergé ; les applis de Filarr comparent `codeHash` à la version publiée et
disent « la même que la version publiée » ou, en rouge, « différente de la version publiée ».

**Ce que cela prouve, et ce que cela ne prouve pas.** Cela prouve que le service **annonce** le code d'une version
publiée. Aucune attestation à distance n'existe sur Cloudflare Workers : personne, Filarr compris, ne peut vous prouver
que le code qui tourne est le code annoncé. C'est pourquoi les versions n'entrent en service que depuis une étiquette
signée, sept jours après leur publication (sauf un correctif de sécurité, journalisé comme tel), pourquoi un journal
public les liste, et pourquoi une revue de sécurité externe précède l'ouverture du service.

## Vérifier une version vous-même

`codeHash` vaut `sha256:` suivi du SHA-256 du fichier `SHA256SUMS` de la version. Ce fichier liste les deux archives
npm **et le module du service**, `host/filarr-gate-host-X.Y.Z.js`, le fichier même qui entre en service
(`wrangler deploy --no-bundle` : rien n'est reconstruit à la mise en service). Depuis un clone, à l'étiquette de la
version :

```sh
npm ci
node scripts/pack-check.mjs release      # construit les archives et le module deux fois, compare, écrit release/SHA256SUMS
sha256sum release/SHA256SUMS             # « sha256: » + ceci = le codeHash qu'annonce une boîte hébergée
curl -s https://ctl.gate.filarr.com/.well-known/filarr-gate-host.json
```

puis comparez `release/SHA256SUMS` au `SHA256SUMS` de la version publiée sur GitHub ([release.fr.md](../release.fr.md)).
La chaîne fait de même avant chaque mise en service : elle télécharge le module publié, le vérifie contre
`SHA256SUMS`, le reconstruit depuis l'étiquette et compare les octets.

## Le journal public des mises en service

Une ligne par événement dans `journal.jsonl`, sur la branche `release-journal` de ce dépôt :

- `published` : écrite par la chaîne de publication à la réception de l'étiquette, avec l'heure de réception (jamais
  la date que porte l'étiquette) ;
- `deployed` : écrite par `.github/workflows/deploy-host.yml`, **sept jours** au moins après l'entrée `published` de la
  même étiquette ; la chaîne refuse plus tôt ;
- `security` : un correctif de sécurité accepté, publié et mis en service au même moment, avec l'avis, sa gravité et la
  mention « correctif de sécurité, délai de sept jours levé ».

La marche à suivre est dans [RELEASING.fr.md](../RELEASING.fr.md#le-service-hébergé).

## Partir

Reprendre la clé pour revenir à une boîte noire à vous transfère les clés d'application, les webhooks et les requêtes
enregistrées avec le paquet de réglages, bascule l'identité, efface la copie hébergée avec un reçu signé, et change les
clés des bases : voyez [le tutoriel](../tutorials/hosted-and-back.fr.md#revenir-chez-vous).
