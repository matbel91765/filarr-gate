// Le journal PUBLIC des mises en service — contrat gate-heberge-1 § 10.1.
// Vecteurs : test/vectors/gate-heberge-1-gate.vectors.json (famille 9, « journal »).
//
// Une entrée par ligne (JSON canonique : clés triées, sans espace), trois sortes :
//   published : version, tag, commit, codeHash, publishedAt — écrite par la chaîne À LA RÉCEPTION de l'étiquette ;
//   deployed  : la même, plus deployedAt, au moins sept jours après publishedAt ;
//   security  : correctif de sécurité, publishedAt = deployedAt, la mention du délai levé, l'avis et sa gravité.
// `codeHash` = "sha256:" + hex(SHA-256 du fichier SHA256SUMS de la version).
//
//   node scripts/release/journal.mjs append <journal.jsonl> --kind published --version 0.2.0 --tag v0.2.0 \
//        --commit <sha> --sums release/SHA256SUMS [--published-at <ISO>]
//   … --kind deployed --published-at <ISO> --deployed-at <ISO>                      (deploy-host.yml)
//   … --kind security --published-at <ISO> --deployed-at <ISO> --advisory GHSA-… --severity high

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const KINDS = ['published', 'deployed', 'security'];
export const DELAY_SECONDS = 7 * 24 * 3600;
export const SECURITY_NOTE = 'correctif de sécurité, délai de sept jours levé';
export const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIELDS = {
  published: ['codeHash', 'commit', 'kind', 'publishedAt', 'tag', 'version'],
  deployed: ['codeHash', 'commit', 'deployedAt', 'kind', 'publishedAt', 'tag', 'version'],
  security: ['advisory', 'codeHash', 'commit', 'deployedAt', 'kind', 'note', 'publishedAt', 'severity', 'tag', 'version'],
};

/** JSON canonique (clés triées en unités de code, sans espace). */
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

export const codeHashOf = (sumsBytes) => `sha256:${createHash('sha256').update(sumsBytes).digest('hex')}`;

/** Les raisons pour lesquelles une entrée n'est pas une entrée valide du journal ([] : valide). */
export function checkEntry(e) {
  const bad = [];
  if (!e || typeof e !== 'object' || !KINDS.includes(e.kind)) return ['kind'];
  const want = FIELDS[e.kind];
  const keys = Object.keys(e).sort();
  if (keys.join(',') !== want.join(',')) bad.push(`champs : ${keys.join(',')} au lieu de ${want.join(',')}`);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(e.version ?? '')) bad.push('version');
  const suffix = e.kind === 'security' ? '-security' : '(-security)?';
  if (!new RegExp(`^v${String(e.version).replace(/\./g, '\\.')}${suffix}$`).test(e.tag ?? '')) bad.push('tag');
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(e.commit ?? '')) bad.push('commit');
  if (!/^sha256:[0-9a-f]{64}$/.test(e.codeHash ?? '')) bad.push('codeHash');
  if (!ISO.test(e.publishedAt ?? '')) bad.push('publishedAt');
  if (e.kind !== 'published') {
    if (!ISO.test(e.deployedAt ?? '')) bad.push('deployedAt');
    const delay = (Date.parse(e.deployedAt) - Date.parse(e.publishedAt)) / 1000;
    if (e.kind === 'deployed' && !(delay >= DELAY_SECONDS)) bad.push('délai de sept jours non tenu');
    if (e.kind === 'security' && delay !== 0) bad.push('correctif : publication et mise en service à la même date');
  }
  if (e.kind === 'security') {
    if (e.note !== SECURITY_NOTE) bad.push('note');
    if (!/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/.test(e.advisory ?? '')) bad.push('advisory');
    if (!SEVERITIES.includes(e.severity)) bad.push('severity');
  }
  return bad;
}

/** Une entrée, vérifiée ; lève si elle n'est pas valide. */
export function journalEntry(fields) {
  const e = { ...fields, ...(fields.kind === 'security' ? { note: SECURITY_NOTE } : {}) };
  const bad = checkEntry(e);
  if (bad.length) throw new Error(`entrée de journal invalide : ${bad.join(' ; ')}`);
  return e;
}

export const journalLine = (entry) => canonical(journalEntry(entry)) + '\n';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, file] = process.argv.slice(2);
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  if (cmd !== 'append' || !file || !arg('sums')) {
    console.error('usage : node scripts/release/journal.mjs append <journal.jsonl> --kind published --version X.Y.Z --tag vX.Y.Z --commit <sha> --sums <SHA256SUMS>');
    process.exit(2);
  }
  const entry = {
    kind: arg('kind') ?? 'published',
    version: arg('version'),
    tag: arg('tag'),
    commit: arg('commit'),
    codeHash: codeHashOf(readFileSync(arg('sums'))),
    publishedAt: arg('published-at') ?? new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
    // Mise en service (deploy-host.yml) : `deployed`, ou `security` avec l'avis et sa gravité
    ...(arg('deployed-at') ? { deployedAt: arg('deployed-at') } : {}),
    ...(arg('advisory') ? { advisory: arg('advisory') } : {}),
    ...(arg('severity') ? { severity: arg('severity') } : {}),
  };
  if (existsSync(file) && readFileSync(file, 'utf8').split('\n').some((l) => l && JSON.parse(l).tag === entry.tag && JSON.parse(l).kind === entry.kind)) {
    console.log(`déjà au journal : ${entry.kind} ${entry.tag}`);
    process.exit(0);
  }
  const line = journalLine(entry);
  appendFileSync(file, line);
  process.stdout.write(line);
}
