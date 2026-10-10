# Installer la boîte noire sur votre ordinateur

[Read in English](install-local.md)

**À la fin**, Filarr Gate tournera sur votre ordinateur, avec son interface de gestion ouverte, une clé d'application,
et une première réponse de l'API locale à `curl`. Comptez une dizaine de minutes.

**Palier :** ouvrir une base à une API est offert à tous les paliers de Filarr (Free : un accès, des changements relevés
à quelques minutes d'intervalle, pas d'écriture). Les limites de chaque palier sont sur la page des offres de Filarr et
dans **Paramètres › Accès API**.

## Avant de commencer

- **Node.js 20.19 ou plus récent** (`node --version`).
- **Un jeton** `flr_live_…` : Filarr le montre une seule fois, quand vous ouvrez une base à une API
  ([ouvrir une base à une API](open-a-database.fr.md)). Pas de compte Filarr sous la main ? L'étape 2 vous donne un
  Filarr en mémoire avec trois bases de démonstration, de quoi suivre chaque tutoriel.
- La boîte noire est le paquet npm `filarr-gate` ; les commandes ci-dessous l'appellent `filarr-gate`.

## 1. Récupérer la boîte noire

```sh
npm install -g filarr-gate@0.2
filarr-gate version
```

(Ou, sans l'installer : `npx filarr-gate@0.2 <commande>`.)

**Ou depuis un clone** de ce dépôt, qui donne aussi le Filarr en mémoire de l'étape 2 :

```sh
git clone https://github.com/filarr-work/filarr-gate.git
cd filarr-gate
npm ci
npm run build
```

`npm run build` construit la bibliothèque, la commande et l'interface de gestion. Faites ensuite un alias pour ce
terminal :

```sh
alias filarr-gate="node $PWD/packages/cli/dist/cli.js"
filarr-gate version
```

Sous PowerShell :

```powershell
$gateCli = "$PWD\packages\cli\dist\cli.js"; function filarr-gate { node $gateCli @args }
```

## 2. (Facultatif) Un Filarr pour essayer

Dans un deuxième terminal, depuis un clone (étape 1) :

```sh
npm run mock-filarr
```

Il lance un Filarr en mémoire sur `http://127.0.0.1:8790`, avec trois bases (Clients, Commandes, Catalogue) ouvertes à
un accès nommé « ERP Atelier », affiche le jeton de cet accès, et fait un changement toutes les 20 secondes pour que
vous voyiez les changements arriver. Puis, dans votre premier terminal, faites pointer la boîte noire vers lui :

```sh
export FILARR_GATE_API_URL=http://127.0.0.1:8790     # PowerShell : $env:FILARR_GATE_API_URL = "http://127.0.0.1:8790"
```

Avec un vrai jeton, sautez cette étape : la boîte noire s'adresse par défaut à `https://api.filarr.com`.

## 3. Donner son jeton à la boîte noire

Deux façons ; choisissez-en une.

**Par la commande** (le jeton et le mot de passe de gestion sont enregistrés dans le répertoire d'état,
`~/.filarr-gate`, dans des fichiers que seul votre utilisateur peut lire) :

```sh
filarr-gate init --token flr_live_… --admin-password 'un-long-mot-de-passe-ici'
```

**Par l'écran de mise en route** : sautez `init`, démarrez la boîte noire (étape suivante) et ouvrez son interface.
Trois étapes : **1 · Le jeton de l'accès** (collez-le, puis **Vérifier le jeton** : la boîte noire interroge Filarr,
tire ses clés et télécharge les blocs chiffrés), **2 · Où vos logiciels la trouvent** (le port, et HTTPS si vous avez
un certificat), **3 · Protéger cette interface** (le mot de passe de gestion, dix caractères au moins).

> Le jeton ne quitte jamais cette machine. La boîte noire en tire la preuve qu'elle présente à Filarr et la clé qui
> ouvre les bases ; Filarr n'en garde qu'une empreinte. Qui détient le jeton, ou le mot de passe de gestion, lit les
> bases qu'il ouvre : traitez-les tous deux comme les clés des données.

## 4. La démarrer

```sh
filarr-gate
```

```text
2026-10-10T03:23:19.567Z INFO  API locale : http://127.0.0.1:8443
2026-10-10T03:23:19.570Z INFO  Interface de gestion : http://127.0.0.1:8787/admin/
2026-10-10T03:23:19.609Z INFO  liaison avec Filarr : connecting
2026-10-10T03:23:19.711Z INFO  liaison avec Filarr : live (Flux des changements ouvert)
```

(Toutes les commandes : [la référence de la ligne de commande](../reference/cli.fr.md).) L'API locale écoute sur
`127.0.0.1:8443`, l'interface de gestion sur `127.0.0.1:8787` : toutes deux ne répondent
qu'à cette machine. `live` veut dire qu'un changement fait dans Filarr arrive à la boîte noire en moins d'une
seconde ; `polling` (palier Free), qu'elle relève Filarr au rythme du palier.

Ouvrez <http://127.0.0.1:8787/admin/>. Le **Tableau de bord** montre les bases, leurs lignes, la liaison avec Filarr ;
**Bases et points d'accès** montre l'adresse de chaque base (`/v1/clients`), ses vues (`/v1/clients/clients-actifs`) et
ses champs.

## 5. Créer une clé d'application

Vos logiciels n'ont jamais le jeton Filarr : chaque programme reçoit sa propre **clé d'application** (`gk_…`),
limitée à ce qu'il lui faut. Laissez la boîte noire tourner et, dans un autre terminal :

```sh
filarr-gate keys create --name "Premier essai" --sql
```

```text
Clé « Premier essai » :

  gk_pre_6Hq…

Elle ne sera plus montrée.
```

La clé ne s'affiche qu'une fois ; la boîte noire n'en garde que l'empreinte. Celle-ci lit toutes les vues et exécute
du SQL. Pour une clé plus restreinte (une base, une vue, l'écriture, une échéance, des adresses autorisées), passez par
**Clés des applications › Nouvelle clé** dans l'interface.

## 6. Votre premier appel

```sh
export FILARR_GATE_KEY=gk_pre_6Hq…
curl -s -H "Authorization: Bearer $FILARR_GATE_KEY" "http://127.0.0.1:8443/v1/clients?limit=2"
```

```json
{"rows":[{"id":"r_acme","nom":"Acme","ville":"Lyon","statut":"Client","ca":12600,"dernier_contact":"2026-10-03",
"commandes":["r_c1","r_c3"],"total_commande":1540.5,"created_at":"2026-09-01T08:00:00.000Z",
"updated_at":"2026-10-10T03:23:24.649Z"},{"id":"r_globex","nom":"Globex", …}],"next":"o2","total":4,"version":2}
```

Chaque ligne est un objet JSON : un champ par colonne, nommé d'après elle (`Dernier contact` devient
`dernier_contact`), plus `id`, `created_at` et `updated_at`. Continuez avec les [premiers appels](first-calls.fr.md) :
filtres, vues, SQL, écriture.

## Vérifier que ça marche

```sh
curl -s http://127.0.0.1:8443/health
filarr-gate doctor
```

```text
ok    filarr                 http://127.0.0.1:8790 répond 200 en 4 ms
ok    horloge                écart avec Filarr : -1 s
ok    jeton                  liaison : live (Flux des changements ouvert) · flr_live_cMAs…SZQg
ok    créateur               clé du créateur : authenticated
ok    base clients           ready · 4 lignes
ok    base commandes         ready · 3 lignes
ok    base catalogue         ready · 2 lignes
…
```

`/health` répond `{"status":"ok","link":"live",…}` avec chaque base et sa version ; `doctor` affiche une ligne par
contrôle (Filarr joignable, l'horloge, le jeton, la clé du créateur, chaque base, la consommation du mois) et renvoie le
code de sortie 1 quand l'un d'eux échoue.

## La garder en marche

`filarr-gate` s'arrête avec son terminal. Pour qu'elle reste en marche, lancez-la comme un service : une unité systemd
sous Linux (`ExecStart=/usr/bin/node /opt/filarr-gate/packages/cli/dist/cli.js`,
`Environment=FILARR_GATE_STATE_DIR=/var/lib/filarr-gate`, `Restart=always`, un utilisateur dédié), un agent launchd
sous macOS, une tâche planifiée « au démarrage » sous Windows ; ou prenez [Docker](install-docker.fr.md), qui la
redémarre pour vous.

Ce que garde le répertoire d'état, et ce qu'il ne garde jamais : le jeton (sauf s'il est donné par
`FILARR_GATE_TOKEN`), les empreintes des clés d'application, les secrets des webhooks, les blocs chiffrés tels que
Filarr les garde, le journal local ; jamais une ligne déchiffrée. Le détail est dans
[sécurité et confiance](../security-and-trust.fr.md).

## Et ensuite

- [Appeler l'API](first-calls.fr.md) en curl, JavaScript ou Python.
- [Recevoir les changements par webhook](webhooks.fr.md).
- [L'installer sur un serveur avec Docker](install-docker.fr.md), ou [sur votre compte
  Cloudflare](install-cloudflare.fr.md).
- Tous les réglages : [configuration](../reference/configuration.fr.md).

## Si ça ne marche pas

- `EADDRINUSE` : un autre programme occupe le port 8443 ou 8787 ; lancez `FILARR_GATE_PORT=9443 filarr-gate`.
- `revoked`, `expired`, `unknown_access` dans le journal : le jeton n'est plus valide ; demandez-en un nouveau à Filarr.
- Une base manque, ou répond `503` : voyez le [dépannage](../troubleshooting.fr.md#une-base-manque-ou-répond-503).
