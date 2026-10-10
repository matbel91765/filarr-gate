# Install the gate on a server with Docker

[Lire en français](install-docker.fr.md)

**At the end** you will have Filarr Gate running on a company server in a container that restarts on its own,
its state kept in a volume, its API behind HTTPS (Caddy), its management UI reachable from the server only, and you
will know how to update it and back it up.

**Plan:** every Filarr plan (see [install on your computer](install-local.md) for what each plan changes).

## Before you start

- A Linux server with Docker and the Compose plugin (`docker compose version`).
- A DNS name pointing at the server (`gate.example.com` below) and ports 80 and 443 open, for the certificate.
- The token `flr_live_…` of the access ([open a database to an API](open-a-database.md)).
- No image is published yet: you build it from a clone of this repository. Its `Dockerfile` makes a small image
  (Node 22, Alpine) that runs as the non-root user `node`, keeps everything in `/data`, and checks its own health.

## 1. Get the files

```sh
git clone https://github.com/filarr-work/filarr-gate.git
cd filarr-gate/examples/docker
cp example.env .env
chmod 600 .env
```

Edit `.env`: paste the token, and choose a management password (ten characters or more).

```sh
FILARR_GATE_TOKEN=flr_live_…
FILARR_GATE_ADMIN_PASSWORD=…
```

Given this way, the token is never written to the volume; it lives in `.env`, readable by root only. Never commit
`.env`.

## 2. The Compose file

`examples/docker/docker-compose.yml`, the gate:

<!-- snippet: examples/docker/docker-compose.yml#gate -->
```yaml
gate:
  build:
    context: ../..
  image: filarr-gate:local
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

and Caddy, which gets and renews the certificate and forwards to the gate:

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

Replace `gate.example.com` with your name. What each choice does:

- **The API is not published** on the host: only Caddy, on the Compose network, reaches port 8443. Your software
  calls `https://gate.example.com`.
- **`FILARR_GATE_TRUST_PROXY`**: the gate believes the caller's address that Caddy forwards (`X-Forwarded-For`) only
  from the Docker networks. App keys limited to some addresses, and the log, then see the real caller.
- **The management UI** is published on `127.0.0.1:8787` of the server only: whoever enters it reads the data.
  Reach it through an SSH tunnel: `ssh -L 8787:127.0.0.1:8787 you@server`, then <http://127.0.0.1:8787/admin/> on
  your computer.
- **`gate-data`** keeps the state (fingerprints of the app keys, webhook secrets, settings), the encrypted block cache
  (a restart does not download everything again), the local log and the encrypted state of the syncs. Without the
  volume, everything starts over at each restart (the data stays in Filarr, but the app keys are lost).
- **`FILARR_GATE_WRITE: "false"`**: writes to Filarr are off by default. Set `"true"` if an application must write
  (the access must also have the database in read and write, and the plan must allow writes: Solo and above).

## 3. Start

```sh
docker compose up -d --build
docker compose logs -f gate
```

```text
… INFO  API locale : http://localhost:8443
… INFO  Interface de gestion : http://localhost:8787/admin/
… INFO  liaison avec Filarr : live (Flux des changements ouvert)
```

`docker compose ps` shows the gate `healthy` after a few seconds: the image's health check calls
`filarr-gate health`, which asks `/health` of the local API.

## 4. An app key, from the server

```sh
docker compose exec gate filarr-gate keys create --name ERP --sql
```

Inside the container, the command goes through the running gate (a local channel whose secret sits in the volume,
readable by the gate's user only): no password needed, and the key works at once. It is printed once.

## 5. First call, from anywhere

```sh
curl -s -H "Authorization: Bearer gk_erp_…" "https://gate.example.com/v1/clients?limit=2"
```

## Check that it works

```sh
curl -s https://gate.example.com/health
docker compose exec gate filarr-gate doctor
```

## Update

```sh
git pull
docker compose up -d --build
```

The volume keeps the keys, webhooks and settings. Pending webhook deliveries live in memory and are dropped by a
restart (the log says how many).

## Back up

Back up the volume while the gate is stopped, or accept a few seconds of lag:

```sh
docker run --rm -v docker_gate-data:/data -v "$PWD":/backup alpine tar czf /backup/gate-data.tgz -C /data .
```

(The volume is named after the Compose project: `docker volume ls` shows its exact name.) The archive holds encrypted
blocks, key fingerprints and webhook secrets, plus the token if you gave it with `init` rather than `.env`: store it
like a secret. To move the gate to another server, prefer the settings package: `filarr-gate export`
([migration](../explain/migration.md)).

## Without Compose

```sh
docker build -t filarr-gate .
docker run -d --name filarr-gate --restart unless-stopped \
  -e FILARR_GATE_TOKEN=flr_live_… \
  -p 8443:8443 -v filarr-gate:/data \
  filarr-gate
docker exec filarr-gate filarr-gate keys create --name ERP
```

Here the API is published as plain HTTP on port 8443 of the host: keep it on a private network, or add
`FILARR_GATE_TLS_CERT` and `FILARR_GATE_TLS_KEY` (paths inside the container) for HTTPS without a proxy.

## Next

- [Call the API](first-calls.md), [receive webhooks](webhooks.md).
- Sync a [PostgreSQL of the local network](sync-postgres.md): the Docker gate reaches it, Filarr never does.
- Every setting: [configuration](../reference/configuration.md).

## If it does not work

- `EACCES` on `/data`: a bind mount owned by root; use the named volume, or give the folder to UID 1000.
- `403 ip_forbidden` for every caller: `FILARR_GATE_TRUST_PROXY` does not match Caddy's address; `docker network
  inspect` shows the subnet.
- More: [troubleshooting](../troubleshooting.md).

> What is checked: every variable this Compose file uses exists in the gate (`npm run docs:check`), and the image
> runs the same `npm run build` as the test suite. What is not: the test suite does not start Docker itself.
