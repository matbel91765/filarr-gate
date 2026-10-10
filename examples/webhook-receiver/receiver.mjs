// A webhook receiver for Filarr Gate, in Node (no dependency): it checks the signature on the
// RAW body, refuses an old timestamp, then acts on the event.
//
//   WEBHOOK_SECRET=whsec_… PORT=8000 node receiver.mjs
//
// Give the gate the address http://<this machine>:8000/filarr when you create the webhook
// (management UI, Webhooks screen); it shows the signing secret once.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const SECRET = process.env.WEBHOOK_SECRET;
if (!SECRET) throw new Error('Set WEBHOOK_SECRET to the secret the gate showed (whsec_…)');

// region verify
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
// endregion

// region handle
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
// endregion

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    // The signature covers the bytes as sent: verify BEFORE parsing
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.method !== 'POST' || !verifySignature(SECRET, raw, req.headers['filarr-gate-signature'])) {
      console.log('refused: bad signature');
      res.writeHead(401).end();
      return;
    }
    // Answer quickly (2xx within 10 s), work afterwards; the gate retries on any other answer
    res.writeHead(204).end();
    handle(JSON.parse(raw));
  });
});

server.listen(Number(process.env.PORT ?? 8000), process.env.HOST ?? '127.0.0.1', () => {
  console.log(`listening on http://${process.env.HOST ?? '127.0.0.1'}:${server.address().port}/filarr`);
});
