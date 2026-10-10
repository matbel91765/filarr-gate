// LES GARDES DE CONFIGURATION DU SERVICE HÉBERGÉ — contrat gate-heberge-1 § 2.0.4 et § 10.3.
//
// Node seul, sans dépendance : utilisé par test/hostConfig.test.ts, et utilisable tel quel par le dépôt de l'API
// pour la garde réciproque (son wrangler.toml ne doit rien déclarer qui mène au service).
//
//  - hostConfigViolations(config)         : packages/host/wrangler.jsonc a son bloc observability PRÉSENT et tout éteint
//                                           (PH12 : un bloc absent est refusé), aucune trace activée, aucune liaison
//                                           hors de SES deux objets durables, aucune autre porte que sa route ;
//  - crossBindingViolations(toml, config) : aucune liaison entre le script de l'API et celui du service, dans un
//                                           sens comme dans l'autre (secrets, objets durables, liaisons de service).
//
// Une violation est une phrase ; une liste vide veut dire « conforme ».

/** JSON avec commentaires (`//` et `/* … *\/`) et virgules finales, comme wrangler le lit. */
export function readJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export const HOST_SCRIPT = 'filarr-gate-host';
export const HOST_ROUTE = { pattern: '*.gate.filarr.com/*', zone_name: 'filarr.com' };
export const HOST_DO = [
  { name: 'GATE_BOX', class_name: 'GateBox' },
  { name: 'GATE_DIRECTORY', class_name: 'GateDirectory' },
];
export const HOST_SECRETS = ['HOST_ENC', 'HOST_SIG', 'FILARR_API_URL'];

/** Les seules clés admises dans la configuration du service : toute liaison d'une autre sorte est refusée. */
export const HOST_ALLOWED_KEYS = [
  '$schema',
  'name',
  'main',
  'no_bundle',
  'compatibility_date',
  'workers_dev',
  'preview_urls',
  'routes',
  'durable_objects',
  'migrations',
  'triggers',
  'vars',
  'secrets',
  'observability',
  'logpush',
  'upload_source_maps',
];

/** Toute trace allumée, où qu'elle soit dans le bloc `observability` (enabled, invocation_logs, persist, échantillonnage). */
function lit(obs, path = 'observability') {
  const out = [];
  if (obs === null || typeof obs !== 'object') return out;
  for (const [k, v] of Object.entries(obs)) {
    const here = `${path}.${k}`;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...lit(v, here));
    else if (typeof v === 'boolean' && v === true && k !== 'redact_query_string') out.push(`${here} est allumé`);
    else if (typeof v === 'number' && /sampling/.test(k) && v > 0) out.push(`${here} = ${v}`);
    else if (Array.isArray(v) && v.length > 0) out.push(`${here} n'est pas vide`);
  }
  return out;
}

export function hostConfigViolations(c) {
  const bad = [];
  for (const k of Object.keys(c)) if (!HOST_ALLOWED_KEYS.includes(k)) bad.push(`clé non admise : ${k} (aucune liaison hors des objets du service, aucune trace)`);
  if (c.name !== HOST_SCRIPT) bad.push(`nom de script ${c.name}, ${HOST_SCRIPT} attendu`);
  if (c.workers_dev !== false) bad.push('workers_dev doit valoir false');
  if (c.preview_urls !== false) bad.push('preview_urls doit valoir false');
  if (JSON.stringify(c.routes) !== JSON.stringify([HOST_ROUTE])) bad.push(`une seule route, ${JSON.stringify(HOST_ROUTE)}`);
  const dos = c.durable_objects?.bindings ?? [];
  if (JSON.stringify(dos) !== JSON.stringify(HOST_DO)) bad.push('les objets durables : GATE_BOX (GateBox) et GATE_DIRECTORY (GateDirectory), sans script_name');
  const classes = (c.migrations ?? []).flatMap((m) => [...(m.new_sqlite_classes ?? []), ...(m.new_classes ?? [])]);
  if (JSON.stringify(classes.sort()) !== JSON.stringify(['GateBox', 'GateDirectory'])) bad.push('migrations : GateBox et GateDirectory en new_sqlite_classes');
  if ((c.migrations ?? []).some((m) => (m.new_classes ?? []).length > 0)) bad.push('new_classes refusé : new_sqlite_classes');
  if (JSON.stringify(c.secrets?.required ?? []) !== JSON.stringify(HOST_SECRETS)) bad.push(`secrets déclarés par leur nom : ${HOST_SECRETS.join(', ')}`);
  for (const name of Object.keys(c.vars ?? {})) if (/^HOST_(ENC|SIG)|FILARR_API_URL|TOKEN|SECRET|PASSWORD|KEY/.test(name)) bad.push(`variable ${name} : un secret ne s'écrit pas dans vars`);
  if (!c.observability || c.observability.enabled !== false) bad.push('observability.enabled doit valoir false, explicitement');
  bad.push(...lit(c.observability));
  if (c.logpush !== false) bad.push('logpush doit valoir false, explicitement');
  if (c.upload_source_maps === true) bad.push('upload_source_maps doit rester éteint');
  return bad;
}

/** Les noms qu'un wrangler.toml déclare (liaisons, classes, scripts visés), lus sans analyseur TOML complet. */
function tomlDeclared(toml) {
  const text = toml.replace(/^\s*#.*$/gm, '');
  const values = (key) => [...text.matchAll(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'gm'))].map((m) => m[1]);
  return {
    bindings: [...values('binding'), ...values('name')],
    classes: [...values('class_name'), ...[...text.matchAll(/new_(?:sqlite_)?classes\s*=\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]))],
    scripts: [...values('script_name'), ...values('service')],
    text,
  };
}

/**
 * Aucune liaison entre le script de l'API (son wrangler.toml) et le service (sa configuration) : ni objet durable
 * de l'un dans l'autre, ni liaison de service, ni secret du service chez l'API, ni ressource de l'API chez le service.
 */
export function crossBindingViolations(apiToml, hostConfig) {
  const bad = [];
  const api = tomlDeclared(apiToml);
  const hostNames = [...HOST_DO.map((d) => d.name), ...HOST_DO.map((d) => d.class_name)];
  for (const n of hostNames) if (api.bindings.includes(n) || api.classes.includes(n)) bad.push(`l'API déclare ${n}, objet du service`);
  if (api.scripts.includes(HOST_SCRIPT)) bad.push(`l'API vise le script ${HOST_SCRIPT}`);
  if (/^\s*HOST_(ENC|SIG)\w*\s*=/m.test(api.text)) bad.push("l'API porte une clé du service en variable");
  // Le service ne déclare rien de l'API : ni ses noms de liaison, ni ses classes, ni son script
  const hostText = JSON.stringify(hostConfig);
  const apiName = /^\s*name\s*=\s*"([^"]+)"/m.exec(api.text)?.[1];
  for (const n of [...new Set([...api.bindings, ...api.classes])]) {
    if (!n || n === apiName) continue;
    if (hostConfig.durable_objects?.bindings?.some((b) => b.name === n || b.class_name === n)) bad.push(`le service déclare ${n}, de l'API`);
  }
  if (apiName && hostText.includes(`"${apiName}"`)) bad.push(`le service vise le script ${apiName}`);
  for (const d of hostConfig.durable_objects?.bindings ?? []) if (d.script_name) bad.push(`le service lie un objet durable d'un autre script (${d.script_name})`);
  return bad;
}
