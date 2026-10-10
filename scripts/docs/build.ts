/**
 * La documentation GÉNÉRÉE, et les contrôles qui gardent honnête la partie écrite à la main.
 *
 *   npm run docs          réécrit les fichiers générés et les blocs de code recopiés d'examples/
 *   npm run docs:check    ne change rien ; liste chaque écart et sort en 1 (rejoué par `npm test`)
 *
 * Deux langues : chaque page de docs/ a son jumeau `.fr.md` (français) à côté de la page anglaise,
 * et chacune nomme l'autre en tête. Générés, dans les deux langues : docs/reference/configuration,
 * docs/reference/cli, docs/reference/errors, les tables de docs/troubleshooting, et (une fois)
 * docs/openapi/filarr-gate.v1.json.
 * Contrôlés : chaque bloc `<!-- snippet: … -->` égale sa région dans examples/, chaque bloc
 * `<!-- consent: … -->` égale le texte d'accord des vecteurs `gate-heberge-1` (et son empreinte),
 * chaque lien relatif mène quelque part et reste dans la langue de la page, chaque lien vers l'aide
 * de Filarr vise la bonne langue, chaque nom FILARR_GATE_* existe dans le code, et aucun quota de
 * palier n'est écrit en chiffres (les quotas se lisent chez Filarr, `GET /public/api-limits`).
 *
 * Les explications des codes vivent dans codes.ts (anglais) et codes.fr.ts (français) ; les textes
 * des réglages et des commandes, ici, dans les deux langues.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DEFAULTS, ENV, TOML, MIN_POLL_SECONDS, type SettingKey } from '../../packages/server/src/settings';
import { DEFAULT_DENIED_EXTENSIONS, MAX_FILE_BYTES } from '../../packages/core/src/engine/gate/files';
import { BASE_PROBLEMS, FILARR_REV2, FILARR_REV3, LINK_STATES, LOCAL_CODES, PASSED_THROUGH, SYNC_CODES, type CodeText } from './codes';
import { BASE_PROBLEMS_FR, FILARR_REV2_FR, FILARR_REV3_FR, LINK_STATES_FR, LOCAL_CODES_FR, SYNC_CODES_FR } from './codes.fr';
import { genericOpenApi } from './openapi';
import { baseProblemCodes, consentTexts, knownEnvNames, linkStates, localApiCodes, rel, ROOT, syncCodes, vectorCodes } from './scan';

type Lang = 'en' | 'fr';

/** Le lien vers l'autre langue, en tête de chaque page de docs/ : `fichier` est le nom du jumeau. */
const langLink = (lang: Lang, twin: string): string => (lang === 'en' ? `[Lire en français](${twin})` : `[Read in English](${twin})`);

// ==================== Configuration ====================

const SETTING_TEXT: Record<SettingKey, string> = {
  apiUrl: 'The Filarr API. Change it only for a local Filarr (tests, the Filarr bench).',
  host: 'Address the local API listens on. `0.0.0.0` to accept other machines (the Docker image sets it).',
  port: 'Port of the local API.',
  adminHost: 'Address of the management UI. Keep `127.0.0.1` unless a protected proxy stands in front: whoever enters the UI reads the data.',
  adminPort: 'Port of the management UI.',
  write: 'Writes to Filarr through `POST`, `PATCH`, `DELETE`. Off by default; Filarr must also give the access a `rw` right and the plan must allow writes.',
  tlsCert: 'HTTPS for the local API: path of the certificate (PEM). Both `tls_cert` and `tls_key`, or neither.',
  tlsKey: 'HTTPS for the local API: path of the private key (PEM).',
  corsOrigins: 'Web pages allowed to call the API from a browser (`https://shop.example.com`), separated by commas. Empty: every request that carries an `Origin` is refused. `*` allows every page (avoid it).',
  trustProxy: 'Addresses or ranges of reverse proxies whose `X-Forwarded-For` is believed (for IP allow-lists and the log).',
  metrics: 'Prometheus metrics at `/metrics` (no key).',
  mcp: 'The MCP server at `/mcp`, for AI assistants (read only, keys with the MCP right).',
  docs: '`/openapi.json` and `/docs` without a key. Off: a key is needed to read them.',
  journalDays: 'Days the local log is kept (1 to 3650).',
  cache: '`disk`: encrypted blocks are kept in the state directory between restarts. `memory`: nothing on disk, not even encrypted blocks (the copy is downloaded again at each start).',
  pollSeconds: `Polling interval without the live stream, in seconds. Never below ${MIN_POLL_SECONDS}, and never faster than the plan allows.`,
  filesMaxBytes: `File slot: largest file accepted, in bytes. Lower than Filarr's limit if you like, never higher (at most ${MAX_FILE_BYTES}).`,
  filesDeny: 'File slot: extensions refused, separated by commas. Replacing the default list removes its entries: keep them.',
  filesAllow: 'File slot: if set, ONLY these extensions pass (executable signatures are refused anyway).',
  notify: 'Accept Filarr\'s push wake-ups at `/_filarr/notify` (signed with a key derived from the token).',
};

const SETTING_TEXT_FR: Record<SettingKey, string> = {
  apiUrl: "L'API de Filarr. À ne changer que pour un Filarr local (essais, banc de Filarr).",
  host: "Adresse où écoute l'API locale. `0.0.0.0` pour accepter les autres machines (l'image Docker la règle ainsi).",
  port: "Port de l'API locale.",
  adminHost: "Adresse de l'interface de gestion. Gardez `127.0.0.1`, sauf derrière un mandataire protégé : qui entre dans l'interface lit les données.",
  adminPort: "Port de l'interface de gestion.",
  write: "L'écriture vers Filarr par `POST`, `PATCH`, `DELETE`. Éteinte d'office ; Filarr doit aussi donner à l'accès un droit `rw`, et le palier permettre l'écriture.",
  tlsCert: "HTTPS pour l'API locale : chemin du certificat (PEM). `tls_cert` et `tls_key` ensemble, ou aucun des deux.",
  tlsKey: "HTTPS pour l'API locale : chemin de la clé privée (PEM).",
  corsOrigins: "Pages web autorisées à appeler l'API depuis un navigateur (`https://shop.example.com`), séparées par des virgules. Vide : toute requête qui porte un `Origin` est refusée. `*` autorise toutes les pages (à éviter).",
  trustProxy: 'Adresses ou plages des mandataires inverses dont on croit le `X-Forwarded-For` (pour les adresses autorisées et le journal).',
  metrics: 'Métriques Prometheus sur `/metrics` (sans clé).',
  mcp: 'Le serveur MCP sur `/mcp`, pour les assistants IA (lecture seule, clés qui ont le droit MCP).',
  docs: '`/openapi.json` et `/docs` sans clé. Éteint : il faut une clé pour les lire.',
  journalDays: 'Jours de conservation du journal local (de 1 à 3650).',
  cache: "`disk` : les blocs chiffrés restent dans le répertoire d'état d'un démarrage à l'autre. `memory` : rien sur le disque, pas même les blocs chiffrés (la copie se retélécharge à chaque démarrage).",
  pollSeconds: `Intervalle de relève sans flux en direct, en secondes. Jamais sous ${MIN_POLL_SECONDS}, et jamais plus vite que le palier ne le permet.`,
  filesMaxBytes: `Fente à fichiers : plus gros fichier accepté, en octets. Plus bas que la limite de Filarr si vous voulez, jamais plus haut (${MAX_FILE_BYTES} au plus).`,
  filesDeny: "Fente à fichiers : extensions refusées, séparées par des virgules. Remplacer la liste d'office en retire les entrées : gardez-les.",
  filesAllow: "Fente à fichiers : si elle est donnée, SEULES ces extensions passent (les signatures d'exécutables sont refusées quoi qu'il arrive).",
  notify: "Accepter les réveils poussés de Filarr sur `/_filarr/notify` (signés d'une clé tirée du jeton).",
};

const mdValue = (key: SettingKey, lang: Lang): string => {
  const v = DEFAULTS[key];
  const none = lang === 'en' ? 'none' : 'aucune';
  if (key === 'filesDeny') return lang === 'en' ? 'the contract list (below)' : 'la liste du contrat (plus bas)';
  if (key === 'filesMaxBytes') return `\`${v}\` (100 ${lang === 'en' ? 'MiB' : 'Mio'})`;
  if (Array.isArray(v)) return v.length === 0 ? none : `\`${v.join(',')}\``;
  if (v === null) return none;
  return `\`${String(v)}\``;
};

function configurationMd(lang: Lang): string {
  const keys = Object.keys(DEFAULTS) as SettingKey[];
  const tomlOf = (k: SettingKey) => Object.entries(TOML).find(([, v]) => v === k)?.[0] ?? '';
  const texts = lang === 'en' ? SETTING_TEXT : SETTING_TEXT_FR;
  const rows = keys.map((k) => `| \`${ENV[k]}\` | \`${tomlOf(k)}\` | ${mdValue(k, lang)} | ${texts[k]} |`);
  const denied = DEFAULT_DENIED_EXTENSIONS.map((e) => `\`${e}\``).join(', ');
  if (lang === 'fr') {
    return `<!-- Généré par \`npm run docs\` depuis packages/server/src/settings.ts : ne pas modifier à la main. -->

# Configuration

${langLink('fr', 'configuration.md')}

Un réglage vient, dans cet ordre (le premier trouvé l'emporte) :

1. d'une **variable d'environnement** (sur Cloudflare : une variable ou un secret du Worker) ;
2. du fichier **\`gate.toml\`** : \`$FILARR_GATE_STATE_DIR/gate.toml\`, ou le fichier que nomme \`FILARR_GATE_CONFIG\` ;
3. de l'**interface de gestion** (écran Réglages), où il est enregistré dans le répertoire d'état ;
4. de la valeur par défaut.

Un réglage fixé par l'environnement ou par \`gate.toml\` apparaît **verrouillé** dans l'interface.

## Les réglages

| variable d'environnement | \`gate.toml\` | par défaut | ce qu'il fait |
|---|---|---|---|
${rows.join('\n')}

Les booléens acceptent \`true\`, \`false\`, \`1\`, \`0\`, \`yes\`, \`no\`, \`on\`, \`off\`. Les listes se séparent par des virgules dans une variable, et s'écrivent en tableau dans \`gate.toml\`.

La liste d'office des extensions refusées (\`files_deny\`) : ${denied}.

## Autres variables

| variable | ce qu'elle fait |
|---|---|
| \`FILARR_GATE_TOKEN\` | Le jeton de l'accès (\`flr_live_…\`). Donné ainsi, il n'est jamais écrit sur le disque. Sinon, \`filarr-gate init\` ou l'écran de mise en route l'enregistre dans le répertoire d'état (fichier \`token\`, mode 0600). |
| \`FILARR_GATE_ADMIN_PASSWORD\` | Le mot de passe de gestion, à la place de celui choisi à l'écran de mise en route (10 caractères au moins). |
| \`FILARR_GATE_STATE_DIR\` | Le répertoire d'état : \`~/.filarr-gate\` par défaut, \`/data\` dans l'image Docker. |
| \`FILARR_GATE_CONFIG\` | Le chemin d'un \`gate.toml\` placé ailleurs que dans le répertoire d'état. |
| \`FILARR_GATE_EXTDB_<ID>\` | La clé d'une base externe que nomme une définition de synchro : \`<ID>\` est formé des 8 premiers caractères après \`xs_\` de l'identifiant de la définition, en majuscules. Le nom exact s'affiche sur l'écran **Sources** et dans \`filarr-gate sources list\`. |
| \`FILARR_GATE_LOG_LEVEL\` | \`debug\`, \`info\` (par défaut), \`warn\`, \`error\`. |
| \`FILARR_GATE_PUBLIC_URL\` | Variante Cloudflare : l'adresse à afficher et à donner, quand ce n'est pas celle où arrivent les requêtes. |
| \`FILARR_GATE_ADMIN_URL\` | Ligne de commande : l'interface de gestion d'une boîte noire d'une autre machine (comme \`--remote\`). |
| \`FILARR_GATE_URL\`, \`FILARR_GATE_KEY\` | \`filarr-gate mcp\` : l'API locale vers laquelle relayer, et la clé d'application à employer (comme \`--gate\` et \`--key\`). |
| \`FILARR_GATE_NEW_TOKEN\` | \`filarr-gate export\` : le jeton de la boîte noire qui prend la suite (comme \`--for-token\`). |

## \`gate.toml\`

\`\`\`toml
# $FILARR_GATE_STATE_DIR/gate.toml
port = 8443
write = true
cors_origins = ["https://shop.example.com"]
trust_proxy = ["127.0.0.1"]
files_allow = [".pdf", ".csv", ".xlsx"]

# La clé d'une base externe, par identifiant de définition de synchro (jamais envoyée à Filarr)
[extdb."xs_AbCdEfGhIjKlMnOpQrStUv"]
secret = "…"
\`\`\`

Seul un sous-ensemble de TOML est pris en charge : \`clé = valeur\` (chaîne, nombre, booléen, tableau de chaînes), les en-têtes \`[section]\` et les commentaires \`#\`.
`;
  }
  return `<!-- Generated by \`npm run docs\` from packages/server/src/settings.ts: do not edit by hand. -->

# Configuration

${langLink('en', 'configuration.fr.md')}

A setting comes from, in this order (the first one found wins):

1. an **environment variable** (on Cloudflare: a Worker variable or secret);
2. the **\`gate.toml\`** file: \`$FILARR_GATE_STATE_DIR/gate.toml\`, or the file named by \`FILARR_GATE_CONFIG\`;
3. the **management UI** (Settings screen), saved in the state directory;
4. the default value.

A setting fixed by the environment or by \`gate.toml\` is shown **locked** in the UI.

## Settings

| environment variable | \`gate.toml\` | default | what it does |
|---|---|---|---|
${rows.join('\n')}

Booleans accept \`true\`, \`false\`, \`1\`, \`0\`, \`yes\`, \`no\`, \`on\`, \`off\`. Lists are separated by commas in a variable, and written as arrays in \`gate.toml\`.

The default list of refused extensions (\`files_deny\`): ${denied}.

## Other variables

| variable | what it does |
|---|---|
| \`FILARR_GATE_TOKEN\` | The access token (\`flr_live_…\`). Given this way, it is never written to disk. Otherwise \`filarr-gate init\` or the setup screen stores it in the state directory (file \`token\`, mode 0600). |
| \`FILARR_GATE_ADMIN_PASSWORD\` | The management password, instead of the one chosen on the setup screen (10 characters at least). |
| \`FILARR_GATE_STATE_DIR\` | The state directory: \`~/.filarr-gate\` by default, \`/data\` in the Docker image. |
| \`FILARR_GATE_CONFIG\` | Path of a \`gate.toml\` elsewhere than in the state directory. |
| \`FILARR_GATE_EXTDB_<ID>\` | The key of an external database a sync definition names: \`<ID>\` is the first 8 characters after \`xs_\` of the definition id, in upper case. The exact name is shown on the **Sources** screen and by \`filarr-gate sources list\`. |
| \`FILARR_GATE_LOG_LEVEL\` | \`debug\`, \`info\` (default), \`warn\`, \`error\`. |
| \`FILARR_GATE_PUBLIC_URL\` | Cloudflare variant: the address to show and give out, when it is not the one requests arrive on. |
| \`FILARR_GATE_ADMIN_URL\` | Command line: the management UI of a gate on another machine (same as \`--remote\`). |
| \`FILARR_GATE_URL\`, \`FILARR_GATE_KEY\` | \`filarr-gate mcp\`: the local API to relay to, and the app key to use (same as \`--gate\` and \`--key\`). |
| \`FILARR_GATE_NEW_TOKEN\` | \`filarr-gate export\`: the token of the gate that takes over (same as \`--for-token\`). |

## \`gate.toml\`

\`\`\`toml
# $FILARR_GATE_STATE_DIR/gate.toml
port = 8443
write = true
cors_origins = ["https://shop.example.com"]
trust_proxy = ["127.0.0.1"]
files_allow = [".pdf", ".csv", ".xlsx"]

# The key of an external database, by sync definition id (never sent to Filarr)
[extdb."xs_AbCdEfGhIjKlMnOpQrStUv"]
secret = "…"
\`\`\`

Only a subset of TOML is read: \`key = value\` (string, number, boolean, array of strings), \`[section]\` headers, and \`#\` comments.
`;
}

// ==================== Ligne de commande ====================

/** Les descriptions en anglais des commandes de `filarr-gate --help`, par leurs premiers mots. */
const COMMAND_TEXT: Record<string, string> = {
  'filarr-gate [serve]': 'Start the local API and the management UI (the default command).',
  'filarr-gate init': 'Store the token (file mode 0600) and the given settings, then stop. `--import FILE` applies a settings package (migration). Refused while a gate runs on the same state directory.',
  'filarr-gate health': 'Probe `/health` of the local API on this machine; exit 0 when it answers 200 (the Docker health check).',
  'filarr-gate doctor': 'Diagnose without changing anything: clock, Filarr, token, creator key, databases and keys, quotas, files, syncs. Exit 1 when a check fails.',
  'filarr-gate version': 'Print the version.',
  'filarr-gate keys create': 'Create an app key that reads every view (`--sql`: SQL too; `--mcp`: MCP; `--files`: file deposits; `--rate`: requests per minute; `--days`: expiry). The key is printed once. Narrower keys (one database, one view, writes) are made in the management UI.',
  'filarr-gate keys list': 'List the app keys (prefix, name, pause, expiry).',
  'filarr-gate keys revoke': 'Revoke a key by its id or the start of its prefix; it stops working at once.',
  'filarr-gate sources list': 'List the external syncs Filarr assigns to this gate, what blocks each one, and where its key comes from.',
  'filarr-gate sources key': 'Give (or clear) the key of an external database; `--stdin` keeps it out of the shell history. Stored encrypted under a key derived from the token.',
  'filarr-gate sources run': 'Run a sync pass now. `--ack-guard PASS` agrees to a stopped pass (safety stop), for that pass only; `--initial source|filarr` settles a first pass that hit too many conflicts.',
  'filarr-gate sources pause': 'Pause a sync on this gate (`sources resume` resumes it). The definition stays in Filarr.',
  'filarr-gate files test': 'Deposit a small test file into the linked deposit box.',
  'filarr-gate files status': 'The status of a deposit (`deposited`, `filed`, `rejected`, `expired`).',
  'filarr-gate export': 'Seal this gate\'s settings (app keys, webhooks, saved queries, sync state, file filter) for the gate that takes over, identified by its new token.',
  'filarr-gate import': 'Apply a sealed settings package made for this gate\'s token.',
  'filarr-gate mcp': 'An MCP server over stdio, for AI assistants that launch a command: it relays to `POST /mcp` of a running gate, with an app key that has the MCP right.',
};

/** Les mêmes, en français (mêmes clés : `npm run docs:check` compare). */
const COMMAND_TEXT_FR: Record<string, string> = {
  'filarr-gate [serve]': "Démarre l'API locale et l'interface de gestion (la commande par défaut).",
  'filarr-gate init': "Enregistre le jeton (fichier en mode 0600) et les réglages donnés, puis s'arrête. `--import FICHIER` applique un paquet de réglages (migration). Refusé tant qu'une boîte noire tourne sur le même répertoire d'état.",
  'filarr-gate health': "Interroge `/health` de l'API locale sur cette machine ; renvoie le code de sortie 0 quand elle répond 200 (le contrôle de santé de Docker).",
  'filarr-gate doctor': 'Diagnostique sans rien changer : horloge, Filarr, jeton, clé du créateur, bases et clés, quotas, fichiers, synchros. Renvoie le code de sortie 1 quand un contrôle échoue.',
  'filarr-gate version': 'Affiche la version.',
  'filarr-gate keys create': "Crée une clé d'application qui lit toutes les vues (`--sql` : le SQL aussi ; `--mcp` : MCP ; `--files` : le dépôt de fichiers ; `--rate` : requêtes par minute ; `--days` : échéance). La clé ne s'affiche qu'une fois. Les clés plus restreintes (une base, une vue, l'écriture) se créent dans l'interface de gestion.",
  'filarr-gate keys list': "Liste les clés d'application (préfixe, nom, pause, échéance).",
  'filarr-gate keys revoke': 'Révoque une clé par son identifiant ou le début de son préfixe ; elle est refusée tout de suite.',
  'filarr-gate sources list': "Liste les synchros externes que Filarr confie à cette boîte noire, ce qui bloque chacune, et d'où vient sa clé.",
  'filarr-gate sources key': "Donne (ou efface) la clé d'une base externe ; `--stdin` la garde hors de l'historique du shell. Conservée chiffrée sous une clé tirée du jeton.",
  'filarr-gate sources run': 'Lance un passage de synchro tout de suite. `--ack-guard PASSAGE` accepte un passage arrêté (garde-fou), pour ce passage seulement ; `--initial source|filarr` tranche un premier passage qui a rencontré trop de conflits.',
  'filarr-gate sources pause': 'Met une synchro en pause sur cette boîte noire (`sources resume` la reprend). La définition reste dans Filarr.',
  'filarr-gate files test': "Dépose un petit fichier d'essai dans la boîte de dépôt liée.",
  'filarr-gate files status': "L'état d'un dépôt (`deposited`, `filed`, `rejected`, `expired`).",
  'filarr-gate export': "Scelle les réglages de cette boîte noire (clés d'application, webhooks, requêtes enregistrées, état des synchros, filtre de fichiers) pour la boîte noire qui prend la suite, désignée par son nouveau jeton.",
  'filarr-gate import': 'Applique un paquet de réglages scellé pour le jeton de cette boîte noire.',
  'filarr-gate mcp': "Un serveur MCP sur stdio, pour les assistants IA qui lancent une commande : il relaie vers `POST /mcp` d'une boîte noire en marche, avec une clé d'application qui a le droit MCP.",
};

function cliHelp(): string {
  const fake = resolve('/home/you/.filarr-gate');
  const res = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'packages', 'cli', 'src', 'cli.ts'), '--help'], {
    cwd: ROOT,
    env: { ...process.env, FILARR_GATE_STATE_DIR: fake },
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`filarr-gate --help failed: ${res.stderr}`);
  return res.stdout.split(fake).join('~/.filarr-gate').replace(/^Filarr Gate \S+ /, 'Filarr Gate <version> ').replace(/\r\n/g, '\n').trimEnd();
}

/** Les commandes du texte d'aide : les lignes qui commencent par `  filarr-gate`. */
function helpCommands(help: string): string[] {
  const out: string[] = [];
  for (const line of help.split('\n')) {
    const m = /^ {2}(filarr-gate (?:\[serve\]|[a-z]+(?: [a-z]+)?))/.exec(line);
    if (!m) continue;
    let cmd = m[1]!;
    // Seules les sous-commandes qui sont des mots de l'aide (`keys create`), pas leurs arguments
    const [, first, second] = cmd.split(' ');
    if (second && !['keys', 'sources', 'files'].includes(first!)) cmd = `filarr-gate ${first}`;
    if (!out.includes(cmd)) out.push(cmd);
    // `sources pause DEF_ID | sources resume DEF_ID` nomme deux commandes sur une ligne
    if (/\| sources resume/.test(line) && !out.includes('filarr-gate sources resume')) out.push('filarr-gate sources resume');
  }
  return out;
}

function cliMd(help: string, lang: Lang, problems: string[]): string {
  const cmds = helpCommands(help);
  if (lang === 'en') {
    for (const c of cmds) if (c !== 'filarr-gate sources resume' && !COMMAND_TEXT[c]) problems.push(`docs/reference/cli.md: the command « ${c} » of the help has no description in scripts/docs/build.ts`);
    for (const c of Object.keys(COMMAND_TEXT)) if (!cmds.includes(c)) problems.push(`docs/reference/cli.md: « ${c} » is described but is no longer in the help`);
  } else {
    for (const c of Object.keys(COMMAND_TEXT)) if (!COMMAND_TEXT_FR[c]) problems.push(`docs/reference/cli.fr.md: the command « ${c} » has no French description in scripts/docs/build.ts`);
    for (const c of Object.keys(COMMAND_TEXT_FR)) if (!COMMAND_TEXT[c]) problems.push(`docs/reference/cli.fr.md: « ${c} » is described in French only`);
  }
  const texts = lang === 'en' ? COMMAND_TEXT : COMMAND_TEXT_FR;
  const usage = (c: string): string => {
    const line = help.split('\n').find((l) => l.startsWith(`  ${c}`)) ?? c;
    return line.trim().replace(/\s{2,}.*$/, '');
  };
  const rows = cmds.filter((c) => texts[c]).map((c) => `| \`${esc(usage(c))}\` | ${esc(texts[c]!)} |`);
  if (lang === 'fr') {
    return `<!-- Généré par \`npm run docs\` depuis \`filarr-gate --help\` (packages/cli/src/cli.ts) : ne pas modifier à la main. -->

# Ligne de commande : \`filarr-gate\`

${langLink('fr', 'cli.md')}

\`\`\`sh
npx filarr-gate <commande> [options]      # ou filarr-gate, après npm install -g filarr-gate
node packages/cli/dist/cli.js <commande>  # depuis un clone, après npm ci && npm run build
docker exec <conteneur> filarr-gate <commande>
\`\`\`

## Commandes

| commande | ce qu'elle fait |
|---|---|
${rows.join('\n')}

## Options communes

| option | |
|---|---|
| \`--json\` | Affiche, pour chaque commande, un JSON qu'un programme peut lire. Les erreurs deviennent \`{ "error", "code" }\`. |
| \`--remote URL\` | Agit sur une boîte noire d'une AUTRE machine, par son interface de gestion, avec \`--admin-password\` (ou \`FILARR_GATE_ADMIN_PASSWORD\`). |
| \`--help\` | Affiche l'aide ci-dessous. |

## Où agit une commande

1. **Une boîte noire qui tourne sur ce répertoire d'état** (\`docker exec\` compris) : la commande passe par elle, sans mot de passe. Une boîte noire en marche écrit \`cli.json\` (mode 0600) dans son répertoire d'état, avec le secret de ce canal, qui ne répond que sur l'adresse de bouclage ; qui peut lire ce répertoire tient déjà le jeton.
2. **\`--remote URL\`** : par l'interface de gestion d'une boîte noire d'une autre machine, avec son mot de passe.
3. **Sinon** : la commande ouvre l'état de la boîte noire le temps du geste (aucun port, aucune synchro planifiée), puis s'arrête. Une clé créée ainsi n'atteint une boîte noire qui tourne ailleurs sur le même état qu'après son redémarrage ; préférez \`--remote\`.

Codes de sortie : \`0\` réussite, \`1\` échec (et \`doctor\` quand un contrôle échoue), \`2\` mauvais usage.

## L'aide, telle qu'elle s'affiche

\`\`\`text
${help}
\`\`\`
`;
  }
  return `<!-- Generated by \`npm run docs\` from \`filarr-gate --help\` (packages/cli/src/cli.ts): do not edit by hand. -->

# Command line: \`filarr-gate\`

${langLink('en', 'cli.fr.md')}

\`\`\`sh
npx filarr-gate <command> [options]       # or filarr-gate, after npm install -g filarr-gate
node packages/cli/dist/cli.js <command>   # from a clone, after npm ci && npm run build
docker exec <container> filarr-gate <command>
\`\`\`

## Commands

| command | what it does |
|---|---|
${rows.join('\n')}

## Common options

| option | |
|---|---|
| \`--json\` | Print JSON that a program can read, for every command. Errors become \`{ "error", "code" }\`. |
| \`--remote URL\` | Act on a gate of ANOTHER machine through its management UI, with \`--admin-password\` (or \`FILARR_GATE_ADMIN_PASSWORD\`). |
| \`--help\` | Print the help below. |

## Where a command acts

1. **A gate running on this state directory** (\`docker exec\` included): the command goes through it, without a password. A running gate writes \`cli.json\` (mode 0600) in its state directory with the secret of this channel, which only answers on the loopback address; whoever can read that directory already holds the token.
2. **\`--remote URL\`**: through the management UI of a gate on another machine, with its password.
3. **Otherwise**: the command opens the gate's state for the time of the gesture (no port, no scheduled sync), then stops. A key created this way reaches a gate that runs elsewhere on the same state only after its restart; prefer \`--remote\`.

Exit codes: \`0\` success, \`1\` failure (and \`doctor\` with a failed check), \`2\` wrong usage.

## The help, as printed

The command line speaks French for now; the table above gives each command in English.

\`\`\`text
${help}
\`\`\`
`;
}

// ==================== Codes ====================

const esc = (s: string): string => s.replace(/\|/g, '\\|');
const remedyText = (r: string[] | 'by-reason' | null | undefined, asleep: Record<string, string[] | null>, lang: Lang): string => {
  if (r === 'by-reason') {
    // Les raisons (`billing`, `tier`…) sont celles des vecteurs ; la ponctuation suit la langue de la page
    const [colon, semi, none] = lang === 'en' ? [': ', '; ', 'none'] : [' : ', ' ; ', 'aucun'];
    return Object.entries(asleep).map(([k, v]) => `${k}${colon}${v ? v.map((x) => `\`${x}\``).join(', ') : none}`).join(semi);
  }
  return r && r.length > 0 ? r.map((x) => `\`${x}\``).join(', ') : '';
};

/** Les contrôles des codes contre le code et les vecteurs (une fois, sur les textes anglais). */
function checkCodes(problems: string[]): void {
  const local = localApiCodes();
  for (const code of local.keys()) if (!LOCAL_CODES[code] && !BASE_PROBLEMS[code]) problems.push(`docs/reference/errors.md: the code « ${code} » of the local API is not explained in scripts/docs/codes.ts`);
  for (const code of Object.keys(LOCAL_CODES)) if (!local.has(code)) problems.push(`docs/reference/errors.md: « ${code} » is explained but no longer exists in the code`);
  for (const [code, t] of Object.entries(LOCAL_CODES)) {
    if (!t.byStatus) continue;
    for (const s of local.get(code) ?? []) if (!t.byStatus[s]) problems.push(`docs/reference/errors.md: « ${code} » has no explanation for its status ${s}`);
  }
  const bases = baseProblemCodes();
  for (const c of bases) if (!BASE_PROBLEMS[c]) problems.push(`docs/reference/errors.md: the base problem « ${c} » is not explained`);
  for (const c of Object.keys(BASE_PROBLEMS)) if (!bases.includes(c)) problems.push(`docs/reference/errors.md: the base problem « ${c} » no longer exists in the code`);
  const links = linkStates();
  for (const c of links) if (!LINK_STATES[c]) problems.push(`docs/reference/errors.md: the link state « ${c} » is not explained`);
  for (const c of Object.keys(LINK_STATES)) if (!links.includes(c)) problems.push(`docs/reference/errors.md: the link state « ${c} » no longer exists in the code`);
  const sync = syncCodes();
  for (const c of sync) if (!SYNC_CODES[c]) problems.push(`docs/reference/errors.md: the sync code « ${c} » is not explained`);
  const contractOnly = ['extdb_relay_limited', 'extdb_web_unsupported'];
  for (const c of Object.keys(SYNC_CODES)) if (!sync.includes(c) && !contractOnly.includes(c)) problems.push(`docs/reference/errors.md: the sync code « ${c} » no longer exists in the code`);
  const { rows } = vectorCodes();
  for (const r of rows) if (!FILARR_REV3[r.code]) problems.push(`docs/reference/errors.md: the Filarr code « ${r.code} » of the vectors is not explained`);
  for (const c of Object.keys(FILARR_REV3)) if (!rows.some((r) => r.code === c)) problems.push(`docs/reference/errors.md: « ${c} » is explained as a revision 3 code but is not in the vectors`);

  // Chaque explication anglaise a sa traduction, et inversement (mêmes codes, mêmes statuts, même champ `gate`)
  const pairs: Array<[string, Record<string, CodeText & { byStatus?: Record<number, CodeText>; gate?: string }>, Record<string, CodeText & { byStatus?: Record<number, CodeText>; gate?: string }>]> = [
    ['LOCAL_CODES', LOCAL_CODES, LOCAL_CODES_FR],
    ['BASE_PROBLEMS', BASE_PROBLEMS, BASE_PROBLEMS_FR],
    ['LINK_STATES', LINK_STATES, LINK_STATES_FR],
    ['FILARR_REV2', FILARR_REV2, FILARR_REV2_FR],
    ['FILARR_REV3', FILARR_REV3, FILARR_REV3_FR],
    ['SYNC_CODES', SYNC_CODES, SYNC_CODES_FR],
  ];
  for (const [name, en, fr] of pairs) {
    for (const [code, t] of Object.entries(en)) {
      const f = fr[code];
      if (!f) {
        problems.push(`scripts/docs/codes.fr.ts: « ${code} » (${name}) has no French text`);
        continue;
      }
      for (const s of Object.keys(t.byStatus ?? {})) if (!f.byStatus?.[Number(s)]) problems.push(`scripts/docs/codes.fr.ts: « ${code} » (${name}) has no French text for its status ${s}`);
      if (t.gate && !f.gate) problems.push(`scripts/docs/codes.fr.ts: « ${code} » (${name}) has no French text for what the gate does`);
    }
    for (const code of Object.keys(fr)) if (!en[code]) problems.push(`scripts/docs/codes.fr.ts: « ${code} » (${name}) is explained in French only`);
  }
}

function errorsMd(lang: Lang): string {
  const T =
    lang === 'en'
      ? { local: LOCAL_CODES, bases: BASE_PROBLEMS, links: LINK_STATES, rev2: FILARR_REV2 as Record<string, CodeText & { gate: string }>, rev3: FILARR_REV3, sync: SYNC_CODES }
      : { local: LOCAL_CODES_FR, bases: BASE_PROBLEMS_FR, links: LINK_STATES_FR, rev2: FILARR_REV2_FR, rev3: FILARR_REV3_FR, sync: SYNC_CODES_FR };
  const local = localApiCodes();
  const localRows: string[] = [];
  for (const code of [...local.keys()].sort()) {
    const t = T.local[code];
    if (!t) continue;
    const statuses = [...local.get(code)!].sort();
    if (t.byStatus) for (const s of statuses) localRows.push(`| \`${code}\` | ${s} | ${esc(t.byStatus[s]?.what ?? '')} | ${esc(t.byStatus[s]?.fix ?? '')} |`);
    else localRows.push(`| \`${code}\` | ${statuses.join(', ')} | ${esc(t.what)} | ${esc(t.fix)} |`);
  }
  const links = linkStates();
  const { rows, asleep } = vectorCodes();
  const table = (head: string, lines: string[]) => `${head}\n${lines.join('\n')}`;
  const baseTable = Object.keys(BASE_PROBLEMS).map((c) => `| \`${c}\` | ${esc(T.bases[c]?.what ?? '')} | ${esc(T.bases[c]?.fix ?? '')} |`);
  const linkTableRows = links.map((c) => `| \`${c}\` | ${esc(T.links[c]?.what ?? '')} | ${esc(T.links[c]?.fix ?? '')} |`);
  const rev2Rows = Object.entries(FILARR_REV2).map(([c, t]) => `| \`${c}\` | ${t.status} | ${esc(T.rev2[c]?.what ?? '')} | ${esc(T.rev2[c]?.gate ?? '')} | ${esc(T.rev2[c]?.fix ?? '')} |`);
  const gateWord = lang === 'en' ? 'Gate:' : 'Boîte noire :';
  const rev3Rows = rows.map((r) => {
    const t = T.rev3[r.code];
    // En français, ce que fait la boîte noire suit un deux-points : sans majuscule
    const gate = t?.gate ? (lang === 'en' ? t.gate : t.gate.charAt(0).toLowerCase() + t.gate.slice(1)) : '';
    return `| \`${r.code}\` | ${r.status} | ${remedyText(r.remedy, asleep, lang)} | ${r.retryAfter ? (lang === 'en' ? 'yes' : 'oui') : ''} | ${esc(t?.what ?? '')}${gate ? ` ${gateWord} ${esc(gate)}` : ''} | ${esc(t?.fix ?? '')} |`;
  });
  const syncRows = Object.keys(SYNC_CODES).map((c) => `| \`${c}\` | ${esc(T.sync[c]?.what ?? '')} | ${esc(T.sync[c]?.fix ?? '')} |`);
  const passed = PASSED_THROUGH.map((c) => `\`${c}\``).join(', ');

  if (lang === 'fr') {
    return `<!-- Généré par \`npm run docs\` depuis le code (packages/gate, packages/server) et les vecteurs test/vectors/boite-noire-v2-serveur.vectors.json : ne pas modifier à la main ; les explications vivent dans scripts/docs/codes.fr.ts. -->

# Codes d'erreur et états

${langLink('fr', 'errors.md')}

Chaque refus de l'API locale est du JSON : \`{ "error": "<message>", "code": "<code>", … }\`. **Fiez-vous à \`code\`** : il est stable ; \`error\` est un message destiné aux humains (en français pour l'instant) et peut changer. Un \`429\` porte \`Retry-After\` (en secondes).

Pour la marche à suivre selon ce que vous voyez, consultez [le dépannage](../troubleshooting.fr.md).

- [Codes de l'API locale](#codes-de-lapi-locale)
- [Codes transmis depuis Filarr](#codes-transmis-depuis-filarr)
- [Pourquoi une base n'est pas servie](#pourquoi-une-base-nest-pas-servie)
- [La liaison avec Filarr](#la-liaison-avec-filarr)
- [Ce que Filarr répond à la boîte noire](#ce-que-filarr-répond-à-la-boîte-noire)
- [États d'une synchro externe](#états-dune-synchro-externe)

## Codes de l'API locale

Les codes que la boîte noire rend elle-même à vos logiciels (et, marqués « Admin », ceux de son API de gestion).

${table("| code | statut | ce qui s'est passé | que faire |\n|---|---|---|---|", localRows)}

## Codes transmis depuis Filarr

Quand Filarr refuse une écriture ou un dépôt de fichier, l'API locale rend tels quels le \`code\` et le statut de Filarr : ${passed}. Ils sont expliqués [plus bas](#ce-que-filarr-répond-à-la-boîte-noire). Tout autre refus de Filarr devient un \`502\` qui porte le code de Filarr.

## Pourquoi une base n'est pas servie

Tant qu'une base n'est pas complète et vérifiée, ses routes répondent \`503\` avec l'un de ces codes. Une fois la base servie, un problème ultérieur ne l'arrête plus : la boîte noire continue de servir sa dernière copie complète et ajoute l'en-tête \`X-Gate-Base-Status\`.

${table("| code | ce qui s'est passé | que faire |\n|---|---|---|", baseTable)}

## La liaison avec Filarr

\`GET /health\` la rend dans \`link\` ; l'interface de gestion et \`filarr-gate doctor\` l'affichent ; la bibliothèque la rend dans \`status().link\`.

${table('| état | ce que cela veut dire | que faire |\n|---|---|---|', linkTableRows)}

## Ce que Filarr répond à la boîte noire

La boîte noire s'en charge seule ; vous les voyez dans son journal, dans \`filarr-gate doctor\`, et transmis pour les écritures et les dépôts. Les codes de la révision 3 portent un **remède** (le vocabulaire dont se servent les applis de Filarr pour proposer un geste : \`upgrade\`, \`wait\`, \`reauthenticate\`, \`manageBilling\`, \`updatePayment\`).

${table("| code | statut | ce qui s'est passé | ce que fait la boîte noire | que faire |\n|---|---|---|---|---|", rev2Rows)}

Révision 3 (boîte hébergée, fichiers, synchros externes), lue dans les vecteurs :

${table("| code | statut | remède | `Retry-After` | ce qui s'est passé | que faire |\n|---|---|---|---|---|---|", rev3Rows)}

## États d'une synchro externe

La boîte noire publie l'état de chaque synchro qu'elle exécute (scellé : Filarr ne peut pas le lire ; les membres de la base, si). Ces codes apparaissent dans cet état, sur l'écran **Sources** et dans \`filarr-gate sources list\` ; jamais comme statut HTTP. Les codes marqués « Web seulement » concernent les synchros exécutées par l'appli web de Filarr.

${table("| code | ce qui s'est passé | que faire |\n|---|---|---|", syncRows)}
`;
  }
  return `<!-- Generated by \`npm run docs\` from the code (packages/gate, packages/server) and the vectors test/vectors/boite-noire-v2-serveur.vectors.json: do not edit by hand; the explanations live in scripts/docs/codes.ts. -->

# Error codes and states

${langLink('en', 'errors.fr.md')}

Every refusal of the local API is JSON: \`{ "error": "<message>", "code": "<code>", … }\`. **Match on \`code\`**: it is stable; \`error\` is a message for people (in French for now) and may change. A \`429\` carries \`Retry-After\` (seconds).

For the steps to follow by symptom, see [troubleshooting.md](../troubleshooting.md).

- [Codes of the local API](#codes-of-the-local-api)
- [Codes passed on from Filarr](#codes-passed-on-from-filarr)
- [Why a database is not served](#why-a-database-is-not-served)
- [The link with Filarr](#the-link-with-filarr)
- [What Filarr answers the gate](#what-filarr-answers-the-gate)
- [States of an external sync](#states-of-an-external-sync)

## Codes of the local API

Codes the gate itself returns to your software (and, marked "Admin", its management API).

${table('| code | status | what happened | what to do |\n|---|---|---|---|', localRows)}

## Codes passed on from Filarr

When Filarr refuses a write or a file deposit, the local API returns Filarr's \`code\` and status unchanged: ${passed}. They are explained [below](#what-filarr-answers-the-gate). Any other refusal of Filarr becomes \`502\` with Filarr's code.

## Why a database is not served

Until a database is complete and verified, its routes answer \`503\` with one of these codes. Once it has been served, a later problem does not stop it: the gate keeps serving its last complete copy and adds the header \`X-Gate-Base-Status\`.

${table('| code | what happened | what to do |\n|---|---|---|', baseTable)}

## The link with Filarr

\`GET /health\` returns it as \`link\`; the management UI and \`filarr-gate doctor\` show it; the library returns it in \`status().link\`.

${table('| state | what it means | what to do |\n|---|---|---|', linkTableRows)}

## What Filarr answers the gate

The gate handles these by itself; you see them in its log, in \`filarr-gate doctor\`, and passed on for writes and deposits. Revision 3 codes come with a **remedy** (the vocabulary Filarr's apps use to propose a gesture: \`upgrade\`, \`wait\`, \`reauthenticate\`, \`manageBilling\`, \`updatePayment\`).

${table('| code | status | what happened | what the gate does | what to do |\n|---|---|---|---|---|', rev2Rows)}

Revision 3 (hosted box, files, external syncs), read from the vectors:

${table('| code | status | remedy | `Retry-After` | what happened | what to do |\n|---|---|---|---|---|---|', rev3Rows)}

## States of an external sync

The gate publishes the state of each sync it runs (sealed: Filarr cannot read it; the members of the database can). These codes appear in that state, in the **Sources** screen and in \`filarr-gate sources list\`; never as an HTTP status. Codes marked "web only" concern syncs run by the Filarr web app.

${table('| code | what happened | what to do |\n|---|---|---|', syncRows)}
`;
}

// ==================== Dépannage : les sections générées ====================

function vectorTable(lang: Lang, problems: string[]): string {
  const { rows, asleep } = vectorCodes();
  const lines: string[] = [];
  for (const r of rows) {
    const t: CodeText | undefined = lang === 'en' ? FILARR_REV3[r.code] : FILARR_REV3_FR[r.code];
    if (!t) {
      problems.push(`troubleshooting (${lang}): « ${r.code} » has no text`);
      continue;
    }
    lines.push(`| \`${r.code}\` | ${r.status} | ${remedyText(r.remedy, asleep, lang)}${r.retryAfter ? (lang === 'en' ? ' (with `Retry-After`)' : ' (avec `Retry-After`)') : ''} | ${esc(t.what)} | ${esc(t.fix)} |`);
  }
  const head = lang === 'en' ? '| code | status | remedy | what happened | what to do |' : "| code | statut | remède | ce qui s'est passé | que faire |";
  return `${head}\n|---|---|---|---|---|\n${lines.join('\n')}`;
}

function linkTable(lang: Lang, problems: string[]): string {
  const states = linkStates();
  const texts = lang === 'en' ? LINK_STATES : LINK_STATES_FR;
  for (const s of states) if (!texts[s]) problems.push(`troubleshooting (${lang}): the link state « ${s} » has no text`);
  const head = lang === 'en' ? '| state | what it means | what to do |' : '| état | ce que cela veut dire | que faire |';
  return `${head}\n|---|---|---|\n${states.map((s) => `| \`${s}\` | ${esc(texts[s]?.what ?? '')} | ${esc(texts[s]?.fix ?? '')} |`).join('\n')}`;
}

/** Remplace le contenu entre `<!-- generated:NOM -->` et `<!-- /generated:NOM -->`. */
function fillSections(text: string, file: string, sections: Record<string, string>, problems: string[]): string {
  let out = text;
  for (const [name, body] of Object.entries(sections)) {
    const re = new RegExp(`(<!-- generated:${name} -->)\\n(?:[\\s\\S]*?\\n)?(<!-- /generated:${name} -->)`);
    if (!re.test(out)) {
      problems.push(`${file}: the section « generated:${name} » is missing`);
      continue;
    }
    out = out.replace(re, (_m, a: string, b: string) => `${a}\n${body}\n${b}`);
  }
  return out;
}

// ==================== Les blocs recopiés d'examples/ et des vecteurs ====================

/** Les lignes entre les commentaires `region NOM` et `endregion` d'un fichier (toute syntaxe de commentaire), désindentées. */
export function region(file: string, name: string): string | null {
  const lines = readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => new RegExp(`(#|//|--|<!--)\\s*region ${name}\\b`).test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /(#|\/\/|--|<!--)\s*endregion\b/.test(l));
  if (end < 0) return null;
  const body = lines.slice(start + 1, end).filter((l) => !/(#|\/\/|--|<!--)\s*(end)?region\b/.test(l));
  const indent = Math.min(...body.filter((l) => l.trim() !== '').map((l) => /^ */.exec(l)![0].length));
  return body.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n').trimEnd();
}

function fillSnippets(text: string, file: string, problems: string[]): string {
  // Le bloc se ferme à la première ligne faite de ``` seuls (un bloc vide compris)
  return text.replace(/(<!-- snippet: ([^\s#]+)(?:#([A-Za-z0-9_-]+))? -->\n```[^\n]*\n)((?:(?!```$)[^\n]*\n)*?)(```)$/gm, (all, head: string, src: string, name: string | undefined, _body: string, fence: string) => {
    if (!existsSync(join(ROOT, src))) {
      problems.push(`${file}: snippet of a missing file ${src}`);
      return all;
    }
    const content = name ? region(src, name) : readFileSync(join(ROOT, src), 'utf8').replace(/\r\n/g, '\n').trimEnd();
    if (content === null) {
      problems.push(`${file}: no region « ${name} » in ${src}`);
      return all;
    }
    return `${head}${content}\n${fence}`;
  });
}

/** L'empreinte d'un texte d'accord, comme le contrat `gate-heberge-1` la définit (§ 3.2). */
export const consentHash = (text: string): string => createHash('sha256').update(text.normalize('NFC'), 'utf8').digest('hex');

/** Les pages qui doivent recopier le texte d'accord, mot pour mot, dans leur langue. */
const CONSENT_PAGES: Record<string, Lang> = { 'docs/security-and-trust.md': 'en', 'docs/security-and-trust.fr.md': 'fr' };

/** Recopie dans chaque bloc `<!-- consent: hebergement-v1 <langue> -->` le texte d'accord des vecteurs. */
function fillConsent(text: string, file: string, consent: ReturnType<typeof consentTexts>, problems: string[]): string {
  const wanted = CONSENT_PAGES[file];
  if (wanted && !text.includes(`<!-- consent: ${consent.version} ${wanted} -->`)) problems.push(`${file}: the consent text ${consent.version} (${wanted}) is missing`);
  return text.replace(/(<!-- consent: ([a-z0-9-]+) (fr|en) -->\n```text\n)((?:(?!```$)[^\n]*\n)*?)(```)$/gm, (all, head: string, version: string, lang: Lang, _body: string, fence: string) => {
    if (version !== consent.version) {
      problems.push(`${file}: the consent text ${version} is not the one of the vectors (${consent.version})`);
      return all;
    }
    return `${head}${consent[lang].text}\n${fence}`;
  });
}

// ==================== Contrôles des pages écrites ====================

function markdownFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      if (n === 'node_modules' || n === 'dist' || n.startsWith('.')) continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.md')) out.push(p);
    }
  };
  walk(join(ROOT, 'docs'));
  walk(join(ROOT, 'examples'));
  for (const f of ['README.md', 'README.fr.md', 'SECURITY.md']) out.push(join(ROOT, f));
  return out;
}

/** Les ancres d'un fichier Markdown, comme GitHub les fabrique. */
function anchors(text: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  for (const m of text.replace(/```[\s\S]*?```/g, '').matchAll(/^#{1,6} (.+)$/gm)) {
    const base = m[1]!
      .trim()
      .toLowerCase()
      .replace(/[`*_]/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** Les mots qui feraient d'un quota de palier un chiffre écrit à la main. */
const QUOTA_NUMBER = /\b\d[\d  ,.]*\s*(?:requests?|requêtes?|writes?|écritures?|commits?|validations?|files?|fichiers?|GB|GiB|Go)\s*(?:\/|per|par|a|an|each)\s*(?:month|mois|day|jour|minute)\b/i;

/** Le jumeau d'une page dans l'autre langue (`x.md` ↔ `x.fr.md`). */
const twinOf = (name: string): string => (name.endsWith('.fr.md') ? name.replace(/\.fr\.md$/, '.md') : name.replace(/\.md$/, '.fr.md'));

function lint(files: string[], problems: string[]): void {
  const envNames = knownEnvNames();
  for (const f of files) {
    const text = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    const name = rel(f);
    const fr = name.endsWith('.fr.md');
    for (const m of text.matchAll(/FILARR_GATE_[A-Z0-9_]+(?:<ID>)?/g)) {
      const v = m[0].startsWith('FILARR_GATE_EXTDB_') && !envNames.has(m[0]) ? 'FILARR_GATE_EXTDB_<ID>' : m[0];
      if (v === 'FILARR_GATE_EXTDB_' || v === 'FILARR_GATE_EXTDB_<ID>' || envNames.has(v)) continue;
      problems.push(`${name}: the variable ${m[0]} does not exist in the code`);
    }
    const prose = text.replace(/```[\s\S]*?```/g, '');
    const q = QUOTA_NUMBER.exec(prose);
    if (q) problems.push(`${name}: a plan quota written as a number (« ${q[0]} »): say where to read it instead (GET /public/api-limits, Usage and limits)`);
    for (const m of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = m[1]!;
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [path, hash] = target.split('#') as [string, string | undefined];
      const file = path === '' ? f : resolve(dirname(f), decodeURIComponent(path));
      if (!existsSync(file)) {
        problems.push(`${name}: link to a missing file ${target}`);
        continue;
      }
      if (hash && file.endsWith('.md') && !anchors(readFileSync(file, 'utf8')).has(hash)) problems.push(`${name}: link to a missing anchor ${target}`);
      // Une page reste dans sa langue : un lien vers une page de l'autre langue n'est permis que vers son propre jumeau
      if (!file.endsWith('.md') || path === '') continue;
      const linked = rel(file);
      if (linked === twinOf(name)) continue;
      if (fr && !linked.endsWith('.fr.md') && existsSync(join(ROOT, twinOf(linked)))) problems.push(`${name}: links to the English page ${target}; link its French twin ${twinOf(linked)}`);
      if (!fr && linked.endsWith('.fr.md')) problems.push(`${name}: links to the French page ${target}`);
    }
    // L'aide de Filarr : https://filarr.com/docs/<slug> en français, https://filarr.com/en/docs/<slug> en anglais
    if (fr && /filarr\.com\/en\/docs\//.test(prose)) problems.push(`${name}: a link to Filarr's English help; the French help is https://filarr.com/docs/<slug>`);
    if (!fr && /filarr\.com\/docs\//.test(prose)) problems.push(`${name}: a link to Filarr's French help; the English help is https://filarr.com/en/docs/<slug>`);
    // Chaque page de docs/ a son jumeau, et le nomme en tête
    if (name.startsWith('docs/')) {
      const twin = twinOf(name);
      if (!existsSync(join(ROOT, twin))) problems.push(`${name}: no ${fr ? 'English' : 'French'} twin (${twin})`);
      const link = langLink(fr ? 'fr' : 'en', basename(twin));
      if (!text.split('\n').slice(0, 12).some((l) => l.includes(link))) problems.push(`${name}: the first lines must link the other language: ${link}`);
    }
  }
}

// ==================== Exécution ====================

export interface DocsResult {
  /** Les fichiers dont le contenu diffère de ce qui serait généré. */
  changed: string[];
  /** Tout le reste de ce qui ne va pas. */
  problems: string[];
}

export function buildDocs(opts: { check: boolean }): DocsResult {
  const problems: string[] = [];
  const outputs = new Map<string, string>();
  const help = cliHelp();
  checkCodes(problems);
  for (const lang of ['en', 'fr'] as const) {
    const sfx = lang === 'en' ? '.md' : '.fr.md';
    outputs.set(`docs/reference/configuration${sfx}`, configurationMd(lang));
    outputs.set(`docs/reference/cli${sfx}`, cliMd(help, lang, problems));
    outputs.set(`docs/reference/errors${sfx}`, errorsMd(lang));
  }
  const codes = [...localApiCodes().keys()].sort();
  outputs.set('docs/openapi/filarr-gate.v1.json', `${JSON.stringify(genericOpenApi(codes), null, 2)}\n`);

  // Le texte d'accord des vecteurs doit lui-même donner l'empreinte du contrat
  const consent = consentTexts();
  for (const lang of ['fr', 'en'] as const) {
    if (consentHash(consent[lang].text) !== consent[lang].hash) problems.push(`test/vectors/gate-heberge-1.vectors.json: the ${lang} consent text does not match its own hash`);
  }

  // Les fichiers à sections générées, et chaque page à blocs recopiés
  const files = markdownFiles();
  for (const f of files) {
    const name = rel(f);
    if (outputs.has(name)) continue;
    let text = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    if (/^docs\/troubleshooting(\.fr)?\.md$/.test(name)) {
      const lang = name.endsWith('.fr.md') ? 'fr' : 'en';
      text = fillSections(text, name, { 'filarr-codes': vectorTable(lang, problems), 'link-states': linkTable(lang, problems) }, problems);
    }
    text = fillSnippets(text, name, problems);
    text = fillConsent(text, name, consent, problems);
    outputs.set(name, text);
  }
  for (const page of Object.keys(CONSENT_PAGES)) if (!outputs.has(page)) problems.push(`${page}: missing (it must carry the consent text)`);

  const changed: string[] = [];
  for (const [name, content] of outputs) {
    const file = join(ROOT, name);
    const now = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
    if (now === content) continue;
    changed.push(name);
    if (!opts.check) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }
  lint(markdownFiles(), problems);
  return { changed, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const check = process.argv.includes('--check');
  const { changed, problems } = buildDocs({ check });
  if (check && changed.length > 0) problems.unshift(...changed.map((c) => `${c}: differs from what \`npm run docs\` generates`));
  if (problems.length > 0) {
    process.stderr.write(`${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(check ? 'documentation: up to date\n' : `documentation: ${changed.length} file(s) written${changed.length ? `\n${changed.map((c) => `  ${c}`).join('\n')}` : ''}\n`);
}
