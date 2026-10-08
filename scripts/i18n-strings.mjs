// Les textes de l'interface qui passent par t(), tr() et plural() : ceux que en.ts doit traduire.
// Usage : node scripts/i18n-strings.mjs [--missing]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../ui/src/', import.meta.url);

function files(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(p));
    else if (/\.tsx?$/.test(entry.name) && entry.name !== 'en.ts') out.push(p);
  }
  return out;
}

/** Une chaîne JS littérale ('…', "…" ou `…` sans ${}). */
const LIT = String.raw`'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|` + '`(?:[^`\\\\$]|\\\\.)*`';

function unquote(lit) {
  const body = lit.slice(1, -1);
  return body.replace(/\\(.)/g, (_m, c) => (c === 'n' ? '\n' : c));
}

export function uiStrings() {
  const keys = new Set();
  const dir = decodeURIComponent(root.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  for (const file of files(dir)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(new RegExp(String.raw`\b(?:t|tr)\(\s*(${LIT})`, 'g'))) keys.add(unquote(m[1]));
    for (const m of text.matchAll(new RegExp(String.raw`\bplural\([^,]+,\s*(${LIT})\s*,\s*(${LIT})`, 'g'))) {
      keys.add(unquote(m[1]));
      keys.add(unquote(m[2]));
    }
  }
  return [...keys].sort();
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/').replace(/^\//, '')}` || process.argv[1]?.endsWith('i18n-strings.mjs')) {
  const all = uiStrings();
  if (process.argv.includes('--missing')) {
    const en = readFileSync(new URL('../ui/src/en.ts', import.meta.url), 'utf8');
    for (const k of all) if (!en.includes(JSON.stringify(k))) console.log(JSON.stringify(k));
  } else {
    for (const k of all) console.log(JSON.stringify(k));
  }
}
