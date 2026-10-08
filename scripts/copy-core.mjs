// Recopie le cœur portable de filarg dans src/core, avec l'en-tête de provenance.
// Usage : node scripts/copy-core.mjs <chemin de filarg>
// Les fichiers restent identiques à la source, hormis les chemins d'import listés dans REWRITES.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const filarg = process.argv[2];
if (!filarg) throw new Error('chemin de filarg attendu');
const BASE = 'src/renderer/components/notes/extensions/inlineDatabase';
const FILES = [
  'types.ts', 'cellFormats.ts', 'relations.ts', 'cellValues.ts', 'dbCore.ts', 'dbCreationModel.ts',
  'dbTemplatesModel.ts', 'columnCalculations.ts', 'importRequests.ts', 'boardLayout.ts', 'viewEngine.ts',
  'people.ts', 'dbIndex.ts', 'formulaEngine.ts',
  'merise/mcd.ts', 'merise/mld.ts',
  'engine/index.ts', 'engine/view.ts', 'engine/table.ts', 'engine/collation.ts', 'engine/sortKernels.ts',
  'engine/liveView.ts',
  'engine/store/canonical.ts', 'engine/store/codec.ts', 'engine/store/crypto.ts', 'engine/store/apiAccess.ts',
  'engine/store/hlc.ts', 'engine/store/registers.ts', 'engine/store/materialize.ts', 'engine/store/zones.ts',
  'engine/store/fracIndex.ts',
  'engine/sql/run.ts', 'engine/sql/parser.ts', 'engine/sql/values.ts', 'engine/sql/messages.ts',
  'engine/sql/catalog.ts',
];
// Le seul écart toléré : les imports de plateforme (i18n, stockage du profil, trousseau) pointent vers des cales.
const REWRITES = {
  'types.ts': [
    ["'../../../../../i18n/config'", "'./shims/i18nConfig'"],
    ["'../../../../../services/core/profileStorage'", "'./shims/profileStorage'"],
    ["'../../../../../services/gateway/keychainCache'", "'./shims/keychainCache'"],
  ],
  'formulaEngine.ts': [["'../../../../../i18n/config'", "'./shims/i18nConfig'"]],
};
const out = join(process.cwd(), 'src', 'core');
const manifest = [];
for (const rel of FILES) {
  const src = `${BASE}/${rel}`;
  const commit = execFileSync('git', ['-C', filarg, 'log', '-1', '--format=%h', '--', src], { encoding: 'utf8' }).trim();
  let text = readFileSync(join(filarg, src), 'utf8');
  for (const [from, to] of REWRITES[rel] ?? []) {
    if (!text.includes(from)) throw new Error(`${rel} : import introuvable ${from}`);
    text = text.split(from).join(to);
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const header = `// Recopié de filarg ${src} @ ${commit} — relicencié Apache-2.0 par le titulaire des droits.${eol}`;
  mkdirSync(dirname(join(out, rel)), { recursive: true });
  writeFileSync(join(out, rel), header + text, 'utf8');
  manifest.push({ file: `src/core/${rel}`, from: src, commit, rewritten: (REWRITES[rel] ?? []).length });
}
// Les rejoueurs des vecteurs dorés (code de test de filarg), recopiés dans test/helpers.
const TESTS = `${BASE}/__tests__/helpers`;
const TEST_FILES = ['storeVectors.ts', 'apiAccessVectors.ts', 'nodeCryptoStore.ts'];
for (const rel of TEST_FILES) {
  const src = `${TESTS}/${rel}`;
  const commit = execFileSync('git', ['-C', filarg, 'log', '-1', '--format=%h', '--', src], { encoding: 'utf8' }).trim();
  let text = readFileSync(join(filarg, src), 'utf8');
  let rewritten = 0;
  text = text.replace(/from '\.\.\/\.\.\/(types|engine\/[^']+)'/g, (_m, path) => {
    rewritten += 1;
    return `from '../../src/core/${path}'`;
  });
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const header = `// Recopié de filarg ${src} @ ${commit} — relicencié Apache-2.0 par le titulaire des droits.${eol}`;
  mkdirSync(join(process.cwd(), 'test', 'helpers'), { recursive: true });
  writeFileSync(join(process.cwd(), 'test', 'helpers', rel), header + text, 'utf8');
  manifest.push({ file: `test/helpers/${rel}`, from: src, commit, rewritten });
}
// La réplique de l'APPLICATION (le client db-store-1 du bureau, du web et du mobile) : les essais
// lui font écrire les magasins que la boîte noire relit. Elle ignore la génération (g = 0).
{
  const src = `${BASE}/engine/store/replica.ts`;
  const commit = execFileSync('git', ['-C', filarg, 'log', '-1', '--format=%h', '--', src], { encoding: 'utf8' }).trim();
  let text = readFileSync(join(filarg, src), 'utf8');
  let rewritten = 0;
  text = text.replace(/from '(\.\/[^']+|\.\.\/\.\.\/types)'/g, (_m, path) => {
    rewritten += 1;
    return path === '../../types' ? `from '../../src/core/types'` : `from '../../src/core/engine/store/${path.slice(2)}'`;
  });
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const header = `// Recopié de filarg ${src} @ ${commit} — relicencié Apache-2.0 par le titulaire des droits.${eol}`;
  writeFileSync(join(process.cwd(), 'test', 'helpers', 'appReplica.ts'), header + text, 'utf8');
  manifest.push({ file: 'test/helpers/appReplica.ts', from: src, commit, rewritten });
}
// Les vecteurs dorés eux-mêmes, depuis les contrats de parité (copie identique).
const CONTRACTS = join(filarg, '..', '.filarr-parity', 'contracts');
mkdirSync(join(process.cwd(), 'test', 'vectors'), { recursive: true });
for (const name of ['api-base-1.vectors.json', 'db-store-1.vectors.json']) {
  writeFileSync(join(process.cwd(), 'test', 'vectors', name), readFileSync(join(CONTRACTS, name)));
  manifest.push({ file: `test/vectors/${name}`, from: `.filarr-parity/contracts/${name}`, commit: null, rewritten: 0 });
}
writeFileSync(join(out, 'PROVENANCE.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(manifest.map((m) => `${m.commit}  ${m.from}${m.rewritten ? ` (imports réécrits : ${m.rewritten})` : ''}`).join('\n'));
