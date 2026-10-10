/**
 * LA MISE EN SERVICE DU SERVICE HÉBERGÉ (contrat gate-heberge-1 § 10.1, PH5 à PH7) :
 *  - `.github/workflows/deploy-host.yml`, lu comme un texte (rien n'est déclenché) ; les gardes communes à
 *    tous les workflows (actions figées par SHA, aucun `${{ }}` dans un script, aucun secret en clair) sont
 *    celles de `test/workflows.test.ts`, qui le parcourt aussi ;
 *  - `scripts/release/host-deploy.mjs`, la décision : sept jours depuis l'entrée « published » du journal
 *    public, ou correctif de sécurité accepté.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide, journalSeverity, lastDeployed, readJournal } from '../scripts/release/host-deploy.mjs';
import { checkEntry, codeHashOf, SECURITY_NOTE } from '../scripts/release/journal.mjs';

const repo = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(repo, ...p), 'utf8').replace(/\r\n/g, '\n');
const deployHost = read('.github', 'workflows', 'deploy-host.yml');
const release = read('.github', 'workflows', 'release.yml');

/** Les travaux d'un fichier de workflow et leurs `needs` (même lecture que workflows.test.ts). */
function jobs(text: string): Map<string, { body: string; needs: string[] }> {
  const part = text.slice(text.indexOf('\njobs:\n'));
  const map = new Map<string, { body: string; needs: string[] }>();
  const re = /^ {2}([A-Za-z][\w-]*):\n((?: {4}.*\n|\n)*)/gm;
  for (const m of part.matchAll(re)) {
    const body = m[2]!;
    const needs = /^ {4}needs: (.*)$/m.exec(body)?.[1] ?? '';
    map.set(m[1]!, { body, needs: needs.replace(/[[\]\s]/g, '').split(',').filter(Boolean) });
  }
  return map;
}

describe('deploy-host.yml', () => {
  const all = jobs(deployHost);

  it('lancée à la main seulement, avec une étiquette, depuis la branche par défaut', () => {
    const on = deployHost.slice(deployHost.indexOf('\non:\n'), deployHost.indexOf('\nenv:\n'));
    expect(on).toMatch(/^\non:\n {2}workflow_dispatch:\n {4}inputs:\n {6}tag:\n/);
    expect(on).not.toMatch(/push|pull_request|schedule|workflow_run|release:/);
    expect(deployHost).toMatch(/^permissions:\n {2}contents: read/m);
    expect(all.get('verify')!.body).toContain('[ "$GITHUB_REF" = "refs/heads/$DEFAULT_BRANCH" ]');
  });

  it('vérifier, essayer, mettre en service, journal : rien ne part sans la vérification et les essais', () => {
    expect([...all.keys()]).toEqual(['verify', 'test', 'deploy', 'journal']);
    expect(all.get('verify')!.needs).toEqual([]);
    expect(all.get('test')!.needs).toEqual(['verify']);
    expect(all.get('deploy')!.needs).toEqual(['verify', 'test']);
    expect(all.get('journal')!.needs).toEqual(['verify', 'deploy']);
  });

  it('signature relue deux fois contre release-signers de la branche par défaut ; journal lu sur release-journal', () => {
    const verify = all.get('verify')!.body;
    for (const f of ['.github/release-signers', 'scripts/release/tag-check.mjs', 'scripts/release/journal.mjs', 'scripts/release/host-deploy.mjs']) expect(verify).toContain(f);
    expect(verify).toContain('git show "FETCH_HEAD:$f"');
    expect(verify).toContain('git show "FETCH_HEAD:journal.jsonl"');
    expect(verify).toContain('node "$RUNNER_TEMP/tag-check.mjs" --tag "$TAG"');
    expect(verify).toContain('gpg.ssh.allowedSignersFile="$RUNNER_TEMP/release-signers" verify-tag "$TAG"');
    expect(verify).toContain('étiquette légère');
    expect(verify).toContain('node "$RUNNER_TEMP/host-deploy.mjs" decide --journal "$RUNNER_TEMP/journal.jsonl" --tag "$TAG"');
    expect(verify).toContain('--sums "$RUNNER_TEMP/release/SHA256SUMS"');
    expect(verify).toContain('git merge-base --is-ancestor "$last" "$commit"');
    expect(verify).toContain('host/filarr-gate-host-$VERSION');
  });

  it('le jeton de Cloudflare n’existe que dans l’environnement host-deploy, lu par le seul travail deploy', () => {
    const deploy = all.get('deploy')!.body;
    expect(deploy).toMatch(/^ {4}environment: host-deploy$/m);
    expect(deploy).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    for (const [name, job] of all) if (name !== 'deploy') expect(job.body, name).not.toContain('CLOUDFLARE');
    expect(deployHost.match(/secrets\.CLOUDFLARE_API_TOKEN/g)).toHaveLength(1);
    for (const workflow of ['ci.yml', 'release.yml']) expect(read('.github', 'workflows', workflow)).not.toContain('CLOUDFLARE');
  });

  it('met en service le module PUBLIÉ tel quel ; ni construction, ni wrangler secret, ni autre wrangler', () => {
    const deploy = all.get('deploy')!.body;
    expect(deploy).toContain('npx wrangler deploy "$RUNNER_TEMP/release/filarr-gate-host-$VERSION.js" --no-bundle');
    expect(deploy).toContain('--config packages/host/wrangler.jsonc');
    for (const v of ['HOST_CODE_HASH:$CODE_HASH', 'HOST_BUILD_REF:$TAG', 'HOST_DEPLOYED_AT:$DEPLOYED_AT', 'HOST_SECURITY_ADVISORY:$ADVISORY']) expect(deploy).toContain(v);
    expect(deploy).not.toMatch(/build\.mjs|npm run build|wrangler secret|--dry-run/);
    expect(deploy).toContain('$CONTROL_URL/.well-known/filarr-gate-host.json');
    expect(deployHost.match(/npx wrangler /g)).toHaveLength(1);
  });

  it('les essais repassent sur le commit étiqueté et le module se reconstruit à l’identique', () => {
    const test = all.get('test')!.body;
    for (const step of ['npm ci', 'npm run typecheck', 'npx vitest run --maxWorkers=2', 'npm run docs:check', 'node scripts/host/build.mjs --outfile', 'cmp "$RUNNER_TEMP/rebuilt.js"']) expect(test).toContain(step);
    expect(test).toContain('ref: ${{ needs.verify.outputs.commit }}');
  });

  it('écrit l’entrée « deployed » ou « security » du journal public', () => {
    const journal = all.get('journal')!.body;
    expect(journal).toContain('--published-at "$PUBLISHED_AT" --deployed-at "$DEPLOYED_AT"');
    expect(journal).toContain('--advisory "$ADVISORY" --severity "$SEVERITY"');
    expect(journal).toContain('node "$RUNNER_TEMP/journal.mjs" append journal.jsonl "$@"');
    expect(journal).toContain('git push origin release-journal');
  });

  it('release.yml joint le module du service à la publication, compté dans SHA256SUMS (PH7)', () => {
    expect(jobs(release).get('pack')!.body).toContain('release/a/host/*.js');
    expect(jobs(release).get('github-release')!.body).toContain('cp "release/a/host/filarr-gate-host-$VERSION.js"');
    expect(read('scripts', 'pack-check.mjs')).toContain('host/filarr-gate-host-${version}.js');
  });
});

describe('host-deploy.mjs : sept jours, ou correctif de sécurité', () => {
  const sums = `${'a'.repeat(64)}  library/filarr-gate-0.3.0.tgz\n`;
  const codeHash = codeHashOf(sums);
  const commit = '1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c';
  const published = { kind: 'published', version: '0.3.0', tag: 'v0.3.0', commit, codeHash, publishedAt: '2026-10-20T10:00:00.000Z' };
  const security = { ...published, tag: 'v0.3.1-security', version: '0.3.1', publishedAt: '2026-10-21T10:00:00.000Z' };
  const deployedBefore = { kind: 'deployed', version: '0.2.0', tag: 'v0.2.0', commit: 'b'.repeat(40), codeHash: `sha256:${'c'.repeat(64)}`, publishedAt: '2026-10-01T00:00:00.000Z', deployedAt: '2026-10-09T00:00:00.000Z' };
  const at = (iso: string) => Date.parse(iso);

  it('lit le journal et sa dernière mise en service ; gravité à l’échelle du journal', () => {
    const entries = readJournal([JSON.stringify(published), 'pas du json', JSON.stringify(deployedBefore), ''].join('\n'));
    expect(entries).toHaveLength(2);
    expect(lastDeployed(entries)?.tag).toBe('v0.2.0');
    expect(journalSeverity('moderate')).toBe('medium');
    expect(journalSeverity('HIGH')).toBe('high');
    expect(journalSeverity('grave')).toBeNull();
  });

  it('refuse avant sept jours COMPTÉS depuis l’entrée « published » (jamais la date de l’étiquette)', () => {
    expect(decide({ entries: [published], tag: 'v0.3.0', codeHash, kind: 'release', ancestor: false, now: at('2026-10-27T09:59:59.000Z') })).toMatchObject({ ok: false, refused: 'seven-days' });
    const ok = decide({ entries: [published], tag: 'v0.3.0', codeHash, kind: 'release', ancestor: false, now: at('2026-10-27T10:00:00.000Z') });
    expect(ok).toMatchObject({ ok: true, entry: { kind: 'deployed', publishedAt: published.publishedAt, deployedAt: '2026-10-27T10:00:00.000Z' } });
    if (ok.ok) expect(checkEntry(ok.entry)).toEqual([]);
  });

  it('refuse une étiquette absente du journal, ou dont l’empreinte n’est pas celle de la publication', () => {
    const later = at('2027-01-01T00:00:00.000Z');
    expect(decide({ entries: [], tag: 'v0.3.0', codeHash, kind: 'release', ancestor: false, now: later })).toMatchObject({ ok: false, refused: 'not-published' });
    expect(decide({ entries: [published], tag: 'v0.3.0', codeHash: `sha256:${'0'.repeat(64)}`, kind: 'release', ancestor: false, now: later })).toMatchObject({ ok: false, refused: 'code-hash' });
  });

  it('correctif de sécurité accepté : sans délai, publication = mise en service, avis et gravité au journal', () => {
    const r = decide({ entries: [deployedBefore, security], tag: 'v0.3.1-security', codeHash, kind: 'security', advisory: 'GHSA-2f9x-4c7m-q8vr', severity: 'moderate', ancestor: true, now: at('2026-10-21T10:05:00.000Z') });
    expect(r).toMatchObject({ ok: true, entry: { kind: 'security', publishedAt: '2026-10-21T10:05:00.000Z', deployedAt: '2026-10-21T10:05:00.000Z', advisory: 'GHSA-2f9x-4c7m-q8vr', severity: 'medium' } });
    if (r.ok) expect(checkEntry({ ...r.entry, note: SECURITY_NOTE })).toEqual([]);
  });

  it('une condition du correctif manque : publication ordinaire, sept jours', () => {
    const now = at('2026-10-21T10:05:00.000Z');
    const base = { entries: [deployedBefore, security], tag: 'v0.3.1-security', codeHash, kind: 'security', advisory: 'GHSA-2f9x-4c7m-q8vr', severity: 'high', ancestor: true, now };
    expect(decide({ ...base, ancestor: false })).toMatchObject({ ok: false, refused: 'seven-days', securityRefused: 'not-from-deployed' });
    expect(decide({ ...base, entries: [security] })).toMatchObject({ ok: false, securityRefused: 'nothing-deployed' });
    expect(decide({ ...base, severity: '' })).toMatchObject({ ok: false, securityRefused: 'severity-unknown' });
    expect(decide({ ...base, advisory: undefined })).toMatchObject({ ok: false, securityRefused: 'advisory-missing' });
    const later = decide({ ...base, ancestor: false, now: at('2026-10-28T10:00:00.000Z') });
    expect(later).toMatchObject({ ok: true, entry: { kind: 'deployed', tag: 'v0.3.1-security' }, securityRefused: 'not-from-deployed' });
    if (later.ok) expect(checkEntry(later.entry)).toEqual([]);
  });
});
