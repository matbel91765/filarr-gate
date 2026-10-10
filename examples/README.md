# Examples

Complete use cases. Each one runs in the test suite against a gate that replicates an in-memory Filarr
(`npm run test:examples`, also part of `npm test`), and the documentation copies its code blocks from here: what you
read is what ran. Python examples use the standard library only; shell examples need bash and curl.

To run one by hand against the demo databases:

```sh
npm ci && npm run build
npm run mock-filarr                                          # terminal 1: an in-memory Filarr, prints a token
FILARR_GATE_API_URL=http://127.0.0.1:8790 FILARR_GATE_TOKEN=flr_live_… FILARR_GATE_WRITE=true \
  node packages/cli/dist/cli.js                              # terminal 2: the gate
node packages/cli/dist/cli.js keys create --name demo --sql  # terminal 3: a key; then the example
FILARR_GATE_URL=http://127.0.0.1:8443 FILARR_GATE_KEY=gk_… node examples/first-calls/calls.mjs
```

(Writes also need a key with write rights on the database: create it in the management UI, **App keys**.)

| example | the case | tested by |
|---|---|---|
| [first-calls](first-calls) | the API in curl, JavaScript and Python: filters, sort, pages, a view, SQL, idempotent writes, a refusal, a `429` waited out | `test/examples.test.ts` |
| [library-node](library-node) | `@filarr/gate`: read, listen to changes, write, stop | `test/examples.test.ts` |
| [webhook-receiver](webhook-receiver) | a webhook receiver in Node and in Python, signature on the raw body | `test/examples.test.ts` |
| [static-site](static-site) | a page built from a view, rebuilt on a webhook | `test/examples.test.ts` |
| [erp-orders-invoices](erp-orders-invoices) | orders written once (idempotent batch), an invoice deposited, its status followed | `test/examples.test.ts` |
| [receive-files](receive-files) | deposits with curl (multipart and raw) and Python; an executable refused | `test/examples.test.ts` |
| [python-nightly-export](python-nightly-export) | SQL to CSV, every night | `test/examples.test.ts` |
| [mcp-assistant](mcp-assistant) | MCP over HTTP, and the stdio relay of a Claude Desktop configuration | `test/examples.test.ts` |
| [public-form](public-form) | a create-only key in a public page, CORS limited to that page | `test/examples.test.ts` |
| [sync-d1](sync-d1) | a D1 table (schema, trigger) synced as a mirror, published, and both ways with the four policies, the "ask me" queue, "Restore" and the safety stop | `test/examples-sync.test.ts` |
| [sync-postgres](sync-postgres) | a PostgreSQL with a limited role, mirrored then synced both ways | `test/examples-sync.test.ts` (skipped without PostgreSQL) |
| [docker](docker) | Docker Compose behind Caddy | variables checked by `npm run docs:check`; not started by the tests |

The `definition.*.json` files of the sync examples are what Filarr's app writes and signs in the database (you do not
write them); the tests sign them the way the app does.
