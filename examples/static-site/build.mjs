// A static page built from a view of Filarr, through Filarr Gate (Node 20+, no dependency).
//
//   FILARR_GATE_URL=http://127.0.0.1:8443 FILARR_GATE_KEY=gk_… node build.mjs [out.html]
//
// The app key only needs to read the view "catalogue/catalogue". Publish the file with any
// static host; rebuild it on a webhook (rebuild-on-webhook.mjs) so a change in Filarr shows up.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = process.env.FILARR_GATE_URL ?? 'http://127.0.0.1:8443';
const KEY = process.env.FILARR_GATE_KEY;
const OUT = process.argv[2] ?? 'index.html';

// region fetch
/** Every row of a view, page after page. */
export async function viewRows(base, view) {
  const rows = [];
  let cursor = null;
  do {
    const res = await fetch(`${GATE}/v1/${base}/${view}?limit=1000${cursor ? `&cursor=${cursor}` : ''}`, { headers: { Authorization: `Bearer ${KEY}` } });
    const page = await res.json();
    if (!res.ok) throw new Error(`${res.status} ${page.code}: ${page.error}`);
    rows.push(...page.rows);
    cursor = page.next;
  } while (cursor);
  return rows;
}
// endregion

// region render
const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const euros = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

export async function build(out = OUT) {
  const products = await viewRows('catalogue', 'catalogue');
  const items = products
    .map((p) => `    <li><strong>${escape(p.produit)}</strong> ${euros.format(p.prix)}${p.stock > 0 ? '' : ' (out of stock)'}</li>`)
    .join('\n');
  writeFileSync(out, `<!doctype html>\n<html lang="fr">\n<meta charset="utf-8">\n<title>Catalogue</title>\n<ul>\n${items}\n</ul>\n</html>\n`);
  return products.length;
}
// endregion

// Run directly (node build.mjs): build once
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!KEY) throw new Error('Set FILARR_GATE_KEY to an app key (gk_…)');
  console.log(`${await build()} products written to ${OUT}`);
}
