// La chaîne peut-elle METTRE EN SERVICE cette étiquette sur le service hébergé ? — contrat gate-heberge-1 § 10.1, PH5, PH6.
//
// Node seul, aucune dépendance : .github/workflows/deploy-host.yml le lance AVANT `npm ci`, lu sur la branche par défaut.
//
//   node scripts/release/host-deploy.mjs decide --journal journal.jsonl --tag vX.Y.Z[-security] --sums SHA256SUMS \
//        --kind release|security [--advisory GHSA-…] [--severity low|medium|high|critical] --ancestor true|false \
//        [--now <ISO>] [--github-output <fichier>]
//   node scripts/release/host-deploy.mjs last-deployed --journal journal.jsonl     → le commit en service, ou rien
//
// La règle :
//  - l'étiquette a son entrée « published » au journal public (écrite par release.yml à la RÉCEPTION de l'étiquette),
//    et l'empreinte du code (`sha256:` + SHA-256 du SHA256SUMS téléchargé de la publication) est la même ;
//  - publication ordinaire : SEPT JOURS au moins entre `publishedAt` de cette entrée (jamais la date que porte
//    l'étiquette) et maintenant ; sinon REFUS ;
//  - correctif de sécurité accepté (tag-check : kind=security, avis existant, clé de rôle security) : sans délai, si
//    une version est EN SERVICE et que le commit de l'étiquette en descend (`--ancestor true`, calculé par la chaîne
//    avec git merge-base), et que la gravité de l'avis est connue ; une condition manque → publication ordinaire.
//  - l'entrée à écrire au journal : `deployed` (publishedAt de l'entrée « published », deployedAt maintenant) ou
//    `security` (publishedAt = deployedAt = maintenant, la mention du délai levé, l'avis, la gravité).

import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DELAY_SECONDS, SEVERITIES, codeHashOf } from './journal.mjs';

/** Les entrées du journal (une par ligne), les lignes illisibles ignorées. */
export function readJournal(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object') out.push(e);
    } catch {
      /* une ligne illisible n'est pas une entrée */
    }
  }
  return out;
}

/** La dernière mise en service (`deployed` ou `security`), par `deployedAt`. */
export function lastDeployed(entries) {
  let best = null;
  for (const e of entries) {
    if ((e.kind !== 'deployed' && e.kind !== 'security') || typeof e.deployedAt !== 'string') continue;
    if (!best || Date.parse(e.deployedAt) > Date.parse(best.deployedAt)) best = e;
  }
  return best;
}

/** La gravité d'un avis GitHub, à l'échelle du journal (`moderate` de l'échelle globale = `medium`). */
export function journalSeverity(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'moderate') return 'medium';
  return SEVERITIES.includes(s) ? s : null;
}

/**
 * @param {{ entries: object[], tag: string, codeHash: string, kind: string, advisory?: string, severity?: string,
 *           ancestor: boolean, now: number }} input
 */
export function decide({ entries, tag, codeHash, kind, advisory, severity, ancestor, now }) {
  const published = entries.find((e) => e.kind === 'published' && e.tag === tag);
  if (!published) return { ok: false, refused: 'not-published', detail: `aucune entrée « published » pour ${tag} au journal public` };
  if (published.codeHash !== codeHash) {
    return { ok: false, refused: 'code-hash', detail: `l'empreinte de la publication (${codeHash}) n'est pas celle du journal (${published.codeHash})` };
  }
  const nowIso = new Date(Math.floor(now / 1000) * 1000).toISOString();
  const base = { version: published.version, tag, commit: published.commit, codeHash };
  if (kind === 'security') {
    const sev = journalSeverity(severity);
    const last = lastDeployed(entries);
    let refused = null;
    if (!advisory) refused = 'advisory-missing';
    else if (!last) refused = 'nothing-deployed';
    else if (ancestor !== true) refused = 'not-from-deployed';
    else if (!sev) refused = 'severity-unknown';
    if (!refused) {
      return { ok: true, entry: { ...base, kind: 'security', publishedAt: nowIso, deployedAt: nowIso, advisory, severity: sev } };
    }
    const ordinary = decide({ entries, tag, codeHash, kind: 'release', now });
    return { ...ordinary, securityRefused: refused };
  }
  const waited = (now - Date.parse(published.publishedAt)) / 1000;
  if (!(waited >= DELAY_SECONDS)) {
    const left = Math.ceil((DELAY_SECONDS - waited) / 3600);
    return { ok: false, refused: 'seven-days', detail: `publiée le ${published.publishedAt} : encore ${left} h avant les sept jours` };
  }
  return { ok: true, entry: { ...base, kind: 'deployed', publishedAt: published.publishedAt, deployedAt: nowIso } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd] = process.argv.slice(2);
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const journal = arg('journal');
  if (!journal) {
    console.error('usage : host-deploy.mjs decide|last-deployed --journal <journal.jsonl> …');
    process.exit(2);
  }
  const entries = readJournal(readFileSync(journal, 'utf8'));
  if (cmd === 'last-deployed') {
    process.stdout.write(lastDeployed(entries)?.commit ?? '');
    process.exit(0);
  }
  if (cmd !== 'decide' || !arg('tag') || !arg('sums') || !arg('kind')) {
    console.error('usage : host-deploy.mjs decide --journal f --tag t --sums f --kind release|security --ancestor true|false');
    process.exit(2);
  }
  const result = decide({
    entries,
    tag: arg('tag'),
    codeHash: codeHashOf(readFileSync(arg('sums'))),
    kind: arg('kind'),
    advisory: arg('advisory') || undefined,
    severity: arg('severity') || undefined,
    ancestor: arg('ancestor') === 'true',
    now: arg('now') ? Date.parse(arg('now')) : Date.now(),
  });
  console.log(JSON.stringify(result, null, 2));
  const out = arg('github-output');
  if (out && result.ok) {
    const e = result.entry;
    const lines = [`entry_kind=${e.kind}`, `version=${e.version}`, `commit=${e.commit}`, `code_hash=${e.codeHash}`, `published_at=${e.publishedAt}`, `deployed_at=${e.deployedAt}`];
    if (e.kind === 'security') lines.push(`advisory=${e.advisory}`, `severity=${e.severity}`);
    if (result.securityRefused) lines.push(`security_refused=${result.securityRefused}`);
    appendFileSync(out, lines.join('\n') + '\n');
  }
  process.exit(result.ok ? 0 : 1);
}
