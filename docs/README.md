# Filarr Gate documentation

Filarr Gate serves the Filarr databases you choose as an API, from a copy it decrypts itself, on your side, without
Filarr ever seeing your data. Start with the [README](../README.md) for the idea in two minutes.

Every code block of the tutorials is copied from [examples/](../examples), and every example runs in the test suite
against a gate before each release (`npm run test:examples`). The tables of settings, commands and codes are generated
from the code (`npm run docs:check` fails when they drift).

**No Filarr account?** `npm run mock-filarr` starts an in-memory Filarr with three demo databases and prints a token:
enough to follow every tutorial.

## Tutorials

| | | |
|---|---|---|
| Install | [on your computer](tutorials/install-local.md) · [on a server with Docker](tutorials/install-docker.md) · [on your Cloudflare account](tutorials/install-cloudflare.md) | |
| Start | [open a database to an API](tutorials/open-a-database.md) (in Filarr) | |
| Use | [call the API: curl, JavaScript, Python](tutorials/first-calls.md) · [the library in your Node program](tutorials/library.md) · [receive changes by webhook](tutorials/webhooks.md) | |
| Sync | [a Cloudflare D1 database, in every direction](tutorials/sync-d1.md) · [a PostgreSQL of your network](tutorials/sync-postgres.md) | Filarr side coming soon |
| Files | [receive files into a Filarr folder](tutorials/receive-files.md) | Filarr side coming soon |
| Hosted | [move to the hosted box, then come back home](tutorials/hosted-and-back.md) | coming soon |
| Safety | [revoke an access, react to a leak](tutorials/revoke.md) · [security and trust: who sees what](security-and-trust.md) | |
| Help | [troubleshooting](troubleshooting.md) | |

## Use cases, complete and tested

| example | the case |
|---|---|
| [first-calls](../examples/first-calls) | the API in curl, JavaScript and Python, with pagination, idempotent writes and `429` |
| [library-node](../examples/library-node) | `@filarr/gate` in a service: read, listen, write, stop cleanly |
| [webhook-receiver](../examples/webhook-receiver) | a signed webhook checked and acted on, in Node and Python |
| [static-site](../examples/static-site) | a catalogue page built from a view and rebuilt on each change |
| [erp-orders-invoices](../examples/erp-orders-invoices) | an ERP that writes its orders once (idempotent batch) and drops its invoices into a folder |
| [receive-files](../examples/receive-files) | depositing files with curl and Python, following their status |
| [python-nightly-export](../examples/python-nightly-export) | a nightly CSV export by SQL |
| [mcp-assistant](../examples/mcp-assistant) | an AI assistant reading your databases over MCP (stdio and HTTP) |
| [public-form](../examples/public-form) | a public form that can only add rows, from one web page |
| [sync-d1](../examples/sync-d1) | a D1 table synced in every direction, with the four conflict policies |
| [sync-postgres](../examples/sync-postgres) | a PostgreSQL of the local network, with a limited role |
| [docker](../examples/docker) | Docker Compose behind Caddy |

## Reference

[The local API](reference/api.md) · [OpenAPI](openapi/filarr-gate.v1.json) · [configuration](reference/configuration.md)
· [command line](reference/cli.md) · [error codes and states](reference/errors.md) · [webhooks](reference/webhooks.md)
· [MCP](reference/mcp.md) · [the library](reference/library.md) · [external database connectors](reference/sync-connectors.md)
· [limits](reference/limits.md) · [contracts](reference/contracts.md)

## Explanations

[Architecture](architecture.md) · [how the gate runs external syncs](external-databases.md) · [the two-way sync](explain/two-way-sync.md) · [moving a gate](explain/migration.md) ·
[the hosted service](explain/hosted.md) · [release plan](release.md)
