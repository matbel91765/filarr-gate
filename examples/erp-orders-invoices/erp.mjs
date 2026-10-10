// An ERP that writes its orders into a Filarr database and drops its invoices into a folder of
// Filarr, through Filarr Gate (Node 20+, no dependency).
//
//   FILARR_GATE_URL=http://127.0.0.1:8443 FILARR_GATE_KEY=gk_… node erp.mjs
//
// The app key needs the create right on "commandes" and the `files` scope; the gate needs
// `write` on, and Filarr must have linked a deposit box to the access (Pro plan and above).
// The Filarr app files each invoice where its placement rules say: neither Filarr nor the gate
// learns where, or under which name.

const GATE = process.env.FILARR_GATE_URL ?? 'http://127.0.0.1:8443';
const KEY = process.env.FILARR_GATE_KEY;
if (!KEY) throw new Error('Set FILARR_GATE_KEY to an app key (gk_…)');
const auth = { Authorization: `Bearer ${KEY}` };

async function check(res) {
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${data.code}: ${data.error}`);
  return { data, headers: res.headers };
}

// region orders
// The day's orders, in ONE request (one commit in Filarr). The Idempotency-Key is the ERP's own
// batch number: if the ERP sends the batch again after a timeout, nothing is written twice.
const batch = 'erp-batch-2026-10-10-001';
const orders = [
  { numero: 'C-2026-1190', client: ['r_acme'], date: '2026-10-10', montant: 1890, payee: false },
  { numero: 'C-2026-1191', client: ['r_globex'], date: '2026-10-10', montant: 420.5, payee: true },
];
for (let attempt = 1; attempt <= 2; attempt += 1) {
  const res = await fetch(`${GATE}/v1/commandes`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': batch },
    body: JSON.stringify(orders),
  });
  const { data, headers } = await check(res);
  console.log(`attempt ${attempt}: ${data.rows.length} orders, Filarr version ${data.version}, replayed=${headers.get('idempotency-replayed') ?? 'false'}`);
}
// endregion

// region deposit
// The invoice of the first order, as a PDF. `path` asks for a sub-folder (applied if the
// deposit box accepts requested paths); `tags` can drive the placement rules.
const pdf = new TextEncoder().encode('%PDF-1.4\n% Invoice C-2026-1190, Acme, 1890.00 EUR\n%%EOF\n');
const form = new FormData();
form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'facture-C-2026-1190.pdf');
form.append('path', 'Factures/2026/10');
form.append('tags', 'facture,acme');
const { data: deposit } = await check(await fetch(`${GATE}/v1/files`, { method: 'POST', headers: auth, body: form }));
console.log(`deposited ${deposit.id}: ${deposit.status}`);
// endregion

// region status
// Wait until a device of the owner files it (every 2 s here; a webhook `file.filed` also exists)
for (let i = 0; i < Number(process.env.WAIT_SECONDS ?? 60) / 2; i += 1) {
  const { data: status } = await check(await fetch(`${GATE}/v1/files/${deposit.id}`, { headers: auth }));
  if (status.status !== 'deposited') {
    console.log(`${deposit.id}: ${status.status} at ${status.filedAt}`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
// endregion
