/**
 * Garde de la chaîne de publication (`.github/`) : aucun secret en clair, aucune expression
 * `${{ … }}` dans un script shell (injection), et `release.yml` ne publie rien sans avoir vérifié
 * la signature de l'étiquette contre `.github/release-signers` lu sur la branche par défaut.
 * Lecture des fichiers seulement : rien n'est déclenché.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkTag, parseSigners } from '../scripts/release/tag-check.mjs';

const repo = join(__dirname, '..');
const gh = join(repo, '.github');
const workflows = readdirSync(join(gh, 'workflows')).filter((f) => f.endsWith('.yml'));
const read = (...p: string[]) => readFileSync(join(...p), 'utf8').replace(/\r\n/g, '\n');
const release = read(gh, 'workflows', 'release.yml');
const ci = read(gh, 'workflows', 'ci.yml');

/** Les scripts shell (`run:` et ses lignes plus indentées). */
function runBlocks(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line);
    if (!m) return;
    const indent = m[1]!.length;
    const body = [m[2]!];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trim() !== '' && l.length - l.trimStart().length <= indent) break;
      body.push(l);
    }
    out.push(body.join('\n'));
  });
  return out;
}

/** Les travaux d'un fichier de workflow et leurs `needs`. */
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

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['jeton npm', /npm_[A-Za-z0-9]{36}/],
  ['jeton GitHub', /\b(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ['clé AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['clé privée', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['jeton Filarr', /flr_live_[A-Za-z0-9_-]{20,}/],
  ['clé d’application', /gk_live_[A-Za-z0-9_-]{8,}/],
  ['jeton Cloudflare ou Stripe', /\b(sk_live_|rk_live_|whsec_)[A-Za-z0-9]{8,}/],
  ['clé SSH publique réelle', /ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}/],
];

describe('la chaîne de publication (.github)', () => {
  it('existe : ci.yml, release.yml, release-signers', () => {
    expect(workflows.sort()).toEqual(['ci.yml', 'release.yml']);
    expect(read(gh, 'release-signers')).toContain('allowed_signers');
  });

  it.each([...workflows.map((f) => ['workflows/' + f] as const), ['release-signers'] as const])('%s : aucun secret en clair', (name) => {
    const text = read(gh, name);
    for (const [what, re] of SECRET_PATTERNS) expect(re.test(text), what).toBe(false);
    // Un secret ne s'écrit jamais en dur : seulement `${{ secrets.NOM }}`
    for (const line of text.split('\n').filter((l) => /secrets\./.test(l))) {
      expect(line, line).toMatch(/\$\{\{[^}]*\bsecrets\.[A-Z_]+[^}]*\}\}/);
    }
    expect(text).not.toMatch(/^\s*(password|token|api[_-]?key|secret)\s*:\s*['"]?[A-Za-z0-9_\-]{16,}/im);
  });

  it.each(workflows)('%s : aucune expression ${{ }} dans un script shell, aucun pull_request_target', (name) => {
    const text = read(gh, 'workflows', name);
    expect(text).not.toContain('pull_request_target');
    expect(runBlocks(text).length).toBeGreaterThan(name === 'release.yml' ? 15 : 4);
    for (const block of runBlocks(text)) expect(block, block).not.toContain('${{');
    expect(runBlocks('      - run: echo "${{ github.event.head_commit.message }}"\n').join('')).toContain('${{');
  });

  it('ci.yml : typage, essais, documentation, construction reproductible', () => {
    for (const step of ['npm ci', 'npm run typecheck', 'npx vitest run', 'npm run docs:check', 'node scripts/pack-check.mjs']) expect(ci).toContain(step);
    expect(ci).toMatch(/^ {2}pull_request:/m);
    expect(ci).toMatch(/^permissions:\n {2}contents: read/m);
  });

  it('release.yml : déclenchée par une étiquette vX.Y.Z seulement', () => {
    const on = release.slice(release.indexOf('\non:\n'), release.indexOf('\nenv:\n'));
    expect(on).toBe("\non:\n  push:\n    tags: ['v*.*.*']\n");
    expect(release).not.toMatch(/workflow_dispatch|pull_request|branches:/);
  });

  it('release.yml : la signature est vérifiée contre release-signers de la branche par défaut, deux fois', () => {
    const verify = jobs(release).get('verify')!.body;
    expect(verify).toContain('git show "FETCH_HEAD:.github/release-signers"');
    expect(verify).toContain('git show "FETCH_HEAD:scripts/release/tag-check.mjs"');
    expect(verify).toMatch(/node "\$RUNNER_TEMP\/tag-check\.mjs" --tag "\$GITHUB_REF_NAME"/);
    expect(verify).toContain('gpg.format=ssh');
    expect(verify).toContain('gpg.ssh.allowedSignersFile="$RUNNER_TEMP/release-signers" verify-tag');
    expect(verify).toContain('étiquette légère');
  });

  it('release.yml : rien ne se publie sans passer par la vérification et les essais', () => {
    const all = jobs(release);
    const ancestors = (name: string, seen = new Set<string>()): Set<string> => {
      for (const n of all.get(name)?.needs ?? []) if (!seen.has(n)) ancestors(n, seen.add(n));
      return seen;
    };
    for (const name of ['npm', 'image', 'github-release', 'journal']) {
      expect(all.has(name), name).toBe(true);
      expect([...ancestors(name)], name).toEqual(expect.arrayContaining(['verify', 'test']));
    }
    expect(all.get('verify')!.needs).toEqual([]);
  });

  it('release.yml : npm avec provenance et OIDC, image multi-architecture au nom paramétré, journal public', () => {
    const all = jobs(release);
    const npm = all.get('npm')!.body;
    expect(npm).toContain('id-token: write');
    expect(npm).toContain('--provenance --access public');
    expect(npm).toContain('"@filarr/gate:release/a/library" "filarr-gate:release/a/cli"');
    expect(release).toMatch(/^env:\n(?: {2}#.*\n)*? {2}IMAGE: ghcr\.io\/[A-Za-z0-9_./-]+$/m);
    const image = all.get('image')!.body;
    expect(image).toContain('platforms: linux/amd64,linux/arm64');
    expect(image).toContain('*OWNER*|*NAME*');
    expect(all.get('journal')!.body).toContain('journal.mjs" append journal.jsonl --kind published');
  });

  it('le modèle release-signers ne déclare aucune clé : toute étiquette, même bien signée, est refusée', async () => {
    const template = read(gh, 'release-signers');
    expect(parseSigners(template)).toEqual([]);
    const v = JSON.parse(read(repo, 'test', 'vectors', 'gate-heberge-1-gate.vectors.json')) as {
      securityTag: { tags: Record<string, Array<{ tag: string; raw: string; expected: { refused?: string } }>> };
    };
    const signed = v.securityTag.tags.ordinary![0]!;
    expect(await checkTag({ tag: signed.tag, raw: signed.raw, signers: template, advisoryExists: () => true })).toMatchObject({ ok: false, refused: 'signer-unknown' });
    const unsigned = v.securityTag.tags.refused!.find((t) => t.expected.refused === 'unsigned')!;
    expect(await checkTag({ tag: unsigned.tag, raw: unsigned.raw, signers: template, advisoryExists: () => true })).toMatchObject({ ok: false, refused: 'unsigned' });
  });
});
