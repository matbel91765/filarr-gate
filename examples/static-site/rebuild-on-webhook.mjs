// Rebuild the static page when the catalogue changes in Filarr: a webhook receiver that checks
// the signature, then runs build.mjs (Node 20+, no dependency).
//
//   FILARR_GATE_URL=… FILARR_GATE_KEY=gk_… WEBHOOK_SECRET=whsec_… PORT=8001 node rebuild-on-webhook.mjs index.html
//
// In the gate's management UI, create a webhook on the "Catalogue" database (events: row added,
// changed, deleted) to http://<this machine>:8001/rebuild.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { build } from './build.mjs';

const SECRET = process.env.WEBHOOK_SECRET;
if (!SECRET) throw new Error('Set WEBHOOK_SECRET to the secret the gate showed (whsec_…)');
const OUT = process.argv[2] ?? 'index.html';

function verifySignature(secret, rawBody, header, now = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries(String(header ?? '').split(',').map((p) => p.trim().split('=', 2)));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(now - t) > 300 || !/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return false;
  return timingSafeEqual(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest(), Buffer.from(parts.v1, 'hex'));
}

// region rebuild
// Several changes in a row trigger ONE rebuild, a second after the last one
let timer = null;
const rebuildSoon = () => {
  clearTimeout(timer);
  timer = setTimeout(async () => console.log(`rebuilt: ${await build(OUT)} products`), 1000);
};
// endregion

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!verifySignature(SECRET, raw, req.headers['filarr-gate-signature'])) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(204).end();
    const event = JSON.parse(raw);
    if (event.base === 'catalogue') rebuildSoon();
  });
});
server.listen(Number(process.env.PORT ?? 8001), '127.0.0.1', async () => {
  console.log(`first build: ${await build(OUT)} products; listening on port ${server.address().port}`);
});
