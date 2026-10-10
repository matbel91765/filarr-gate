# Installer la boîte noire sur un serveur avec Docker

[Read in English](install-docker.md)

**À la fin**, Filarr Gate tournera sur un serveur de l'entreprise, dans un conteneur qui redémarre tout seul, son état
gardé dans un volume, son API derrière HTTPS (Caddy), son interface de gestion joignable depuis le serveur seulement,
et vous saurez la mettre à jour et la sauvegarder.

**Palier :** tous les paliers de Filarr (voyez [l'installation sur votre ordinateur](install-local.fr.md) pour ce que
chaque palier change).

## Avant de commencer

- Un serveur Linux avec Docker et le greffon Compose (`docker compose version`).
- Un nom DNS qui pointe vers le serveur (`gate.example.com` ci-dessous), et les ports 80 et 443 ouverts, pour le
  certificat.
- Le jeton `flr_live_…` de l'accès ([ouvrir une base à une API](open-a-database.fr.md)).
- L'image `ghcr.io/filarr-work/gate` (linux/amd64, linux/arm64) : `:0.2` suit les correctifs 0.2.x, `:0.2.0` fige
  cette version exacte. Elle est petite (Node 22, Alpine), tourne sous l'utilisateur non root `node`, garde tout dans
  `/data`, et contrôle sa propre santé. Elle est signée (cosign) et construite par la chaîne de publication du dépôt
  ([plan de publication](../release.fr.md)).

## 1. Récupérer les fichiers

```sh
mkdir filarr-gate && cd filarr-gate
for f in docker-compose.yml Caddyfile example.env; do
  curl -fsSLO "https://raw.githubusercontent.com/filarr-work/filarr-gate/v0.2.0/examples/docker/$f"
done
cp example.env .env
chmod 600 .env
```

(Ou `git clone https://github.com/filarr-work/filarr-gate.git`, puis `cd filarr-gate/examples/docker`.)

Modifiez `.env` : collez le jeton, et choisissez un mot de passe de gestion (dix caractères ou plus).

```sh
FILARR_GATE_TOKEN=flr_live_…
FILARR_GATE_ADMIN_PASSWORD=…
```

Donné ainsi, le jeton n'est jamais écrit dans le volume ; il vit dans `.env`, lisible par root seulement. Ne versionnez
jamais `.env`.

## 2. Le fichier Compose

`examples/docker/docker-compose.yml`, la boîte noire (les commentaires de l'exemple disent, en anglais : `:0.2` suit les
correctifs 0.2.x et `:0.2.0` fige cette version ; la variante qui construit l'image depuis un clone ; Caddy, sur le
même réseau Docker, transmet l'adresse de l'appelant ; gardez ce volume, il tient l'état, le cache de blocs chiffrés,
le journal et l'état chiffré des synchros ; l'interface de gestion sur CETTE machine seulement, car qui y entre lit les
données ; l'API n'est pas publiée, seul Caddy la joint, sur le port 8443 du réseau) :

<!-- snippet: examples/docker/docker-compose.yml#gate -->
```yaml
gate:
  # `:0.2` follows the 0.2.x fixes; `:0.2.0` pins this exact version.
  image: ghcr.io/filarr-work/gate:0.2
  # Variant, from a clone of the repository: replace the line above with
  #   build:
  #     context: ../..
  #   image: filarr-gate:local
  # and start with `docker compose up -d --build`.
  restart: unless-stopped
  environment:
    FILARR_GATE_TOKEN: ${FILARR_GATE_TOKEN:?paste the token in .env}
    FILARR_GATE_ADMIN_PASSWORD: ${FILARR_GATE_ADMIN_PASSWORD:?choose a password of 10 characters or more}
    # Caddy, on the same Docker network, forwards the caller's address
    FILARR_GATE_TRUST_PROXY: 172.16.0.0/12
    FILARR_GATE_WRITE: "false"
  volumes:
    # State, encrypted block cache, log, encrypted sync state: keep this volume
    - gate-data:/data
  ports:
    # The management UI on THIS machine only: whoever enters it reads the data
    - "127.0.0.1:8787:8787"
  # The API is not published: only Caddy reaches it (port 8443 inside the network)
```

et Caddy, qui obtient et renouvelle le certificat et transmet les requêtes à la boîte noire :

<!-- snippet: examples/docker/docker-compose.yml#caddy -->
```yaml
caddy:
  image: caddy:2
  restart: unless-stopped
  ports:
    - "80:80"
    - "443:443"
  volumes:
    - ./Caddyfile:/etc/caddy/Caddyfile:ro
    - caddy-data:/data
  depends_on:
    - gate
```

<!-- snippet: examples/docker/Caddyfile#caddyfile -->
```text
gate.example.com {
	encode gzip
	reverse_proxy gate:8443
}
```

Remplacez `gate.example.com` par votre nom. Ce que fait chaque choix :

- **L'API n'est pas publiée** sur l'hôte : seul Caddy, sur le réseau Compose, joint le port 8443. Vos logiciels
  appellent `https://gate.example.com`.
- **`FILARR_GATE_TRUST_PROXY`** : la boîte noire ne se fie à l'adresse de l'appelant transmise par Caddy
  (`X-Forwarded-For`) que si la requête vient des réseaux Docker. Les clés d'application limitées à certaines adresses,
  et le journal, voient alors le vrai appelant.
- **L'interface de gestion** n'est publiée que sur `127.0.0.1:8787` du serveur : qui y entre lit les données.
  Joignez-la par un tunnel SSH : `ssh -L 8787:127.0.0.1:8787 vous@serveur`, puis <http://127.0.0.1:8787/admin/> sur
  votre ordinateur.
- **`gate-data`** garde l'état (empreintes des clés d'application, secrets des webhooks, réglages), le cache de blocs
  chiffrés (un redémarrage ne retélécharge pas tout), le journal local et l'état chiffré des synchros. Sans le volume,
  tout repart de zéro à chaque redémarrage (les données restent dans Filarr, mais les clés d'application sont perdues).
- **`FILARR_GATE_WRITE: "false"`** : l'écriture vers Filarr est éteinte d'office. Mettez `"true"` si une application
  doit écrire (l'accès doit aussi avoir la base en lecture et écriture, et le palier permettre l'écriture : Solo et
  plus).

## 3. Démarrer

```sh
docker compose up -d
docker compose logs -f gate
```

```text
… INFO  API locale : http://localhost:8443
… INFO  Interface de gestion : http://localhost:8787/admin/
… INFO  liaison avec Filarr : live (Flux des changements ouvert)
```

`docker compose ps` montre la boîte noire `healthy` au bout de quelques secondes : le contrôle de santé de l'image
appelle `filarr-gate health`, qui interroge `/health` de l'API locale.

## 4. Une clé d'application, depuis le serveur

```sh
docker compose exec gate filarr-gate keys create --name ERP --sql
```

Dans le conteneur, la commande passe par la boîte noire en marche (un canal local dont le secret est dans le volume,
lisible par l'utilisateur de la boîte noire seulement) : pas de mot de passe, et la clé est utilisable tout de suite.
Elle ne s'affiche qu'une fois.

## 5. Premier appel, depuis n'importe où

```sh
curl -s -H "Authorization: Bearer gk_erp_…" "https://gate.example.com/v1/clients?limit=2"
```

## Vérifier que ça marche

```sh
curl -s https://gate.example.com/health
docker compose exec gate filarr-gate doctor
```

## Mettre à jour

```sh
docker compose pull
docker compose up -d
```

`:0.2` apporte les correctifs 0.2.x ; pour une nouvelle version mineure, changez l'étiquette dans `docker-compose.yml`
après avoir lu les [changements](https://github.com/filarr-work/filarr-gate/blob/main/CHANGELOG.fr.md).

Le volume garde les clés, les webhooks et les réglages. Les livraisons de webhooks en attente vivent en mémoire et un
redémarrage les abandonne (le journal dit combien).

## Sauvegarder

Sauvegardez le volume pendant que la boîte noire est arrêtée, ou acceptez quelques secondes de décalage :

```sh
docker run --rm -v docker_gate-data:/data -v "$PWD":/backup alpine tar czf /backup/gate-data.tgz -C /data .
```

(Le volume porte le nom du projet Compose : `docker volume ls` donne son nom exact.) L'archive contient des blocs
chiffrés, des empreintes de clés et les secrets des webhooks, ainsi que le jeton si vous l'avez donné par `init` plutôt
que par `.env` : conservez-la comme un secret. Pour déménager la boîte noire sur un autre serveur, préférez le paquet de
réglages : `filarr-gate export` ([migration](../explain/migration.fr.md)).

## Sans Compose

```sh
docker run -d --name filarr-gate --restart unless-stopped \
  -e FILARR_GATE_TOKEN=flr_live_… \
  -p 8443:8443 -v filarr-gate:/data \
  ghcr.io/filarr-work/gate:0.2
docker exec filarr-gate filarr-gate keys create --name ERP
```

Ici, l'API est publiée en HTTP simple sur le port 8443 de l'hôte : gardez-la sur un réseau privé, ou ajoutez
`FILARR_GATE_TLS_CERT` et `FILARR_GATE_TLS_KEY` (des chemins dans le conteneur) pour du HTTPS sans mandataire.

## Construire l'image vous-même

Depuis un clone de ce dépôt, la même image que celle publiée :

```sh
git clone https://github.com/filarr-work/filarr-gate.git && cd filarr-gate
git checkout v0.2.0
docker build -t filarr-gate:local .
```

Puis, dans `docker-compose.yml`, remplacez `image: ghcr.io/filarr-work/gate:0.2` par les lignes `build:` en
commentaire et démarrez avec `docker compose up -d --build` ; ou donnez `filarr-gate:local` à `docker run`.

## Et ensuite

- [Appeler l'API](first-calls.fr.md), [recevoir des webhooks](webhooks.fr.md).
- Synchroniser un [PostgreSQL du réseau local](sync-postgres.fr.md) : la boîte noire Docker le joint, Filarr jamais.
- Tous les réglages : [configuration](../reference/configuration.fr.md).

## Si ça ne marche pas

- `EACCES` sur `/data` : un montage de dossier qui appartient à root ; prenez le volume nommé, ou donnez le dossier à
  l'UID 1000.
- `403 ip_forbidden` pour tous les appelants : `FILARR_GATE_TRUST_PROXY` ne correspond pas à l'adresse de Caddy ;
  `docker network inspect` montre le sous-réseau.
- Plus de cas : [dépannage](../troubleshooting.fr.md).

> Ce qui est vérifié : chaque variable qu'emploie ce fichier Compose existe dans la boîte noire (`npm run docs:check`),
> et l'image exécute le même `npm run build` que la suite d'essais. Ce qui ne l'est pas : la suite d'essais ne lance
> pas Docker elle-même.
