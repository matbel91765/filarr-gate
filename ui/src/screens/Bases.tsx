/** 3 · Bases et points d'accès. */

import { useEffect, useState } from 'preact/hooks';
import { api, download } from '../api';
import { Badge, baseStatus, CopyButton, ErrorNotice, rightsLabel, useResource } from '../components';
import { fmtBytes, fmtNumber, plural, t, tr } from '../i18n';

interface Field {
  name: string;
  column: string;
  type: string;
  jsonType: string;
  options: string[] | null;
  writable: boolean;
  numberFormat: string | null;
  target: { title: string | null; granted: boolean } | null;
  unresolved: boolean;
}

type Summary = { query: string } | { filters: number; sorts: Array<{ column: string; desc: boolean }>; columns: number | null };

/** Ce que la vue décide, en mots. */
function decides(s: Summary): string {
  if ('query' in s) return s.query;
  const parts: string[] = [];
  if (s.filters) parts.push(plural(s.filters, '{n} filtre', '{n} filtres'));
  if (s.sorts.length) parts.push(t('tri : {list}', { list: s.sorts.map((x) => `${x.column} ${x.desc ? '↓' : '↑'}`).join(', ') }));
  if (s.columns !== null) parts.push(plural(s.columns, '{n} colonne', '{n} colonnes'));
  return parts.join(' · ') || t('toutes les lignes');
}

interface BaseRow {
  storeId: string;
  slug: string | null;
  title: string | null;
  rights: string;
  status: string;
  problem: { code: string; message: string; keys?: Array<{ e: number; g: number }> } | null;
  version?: number;
  rows?: number;
  blocks?: number;
  encryptedBytes?: number;
  keysHeld?: Array<{ e: number; g: number }>;
  generation?: number;
  endpoint?: string;
  methods?: string[];
  keys?: string[];
  writeKeys?: string[];
  views?: Array<{ id: string; slug: string; name: string; type: string; endpoint: string; summary: Summary; keys: string[] }>;
  fields?: Field[];
}

const TYPE_FR: Record<string, string> = {
  text: tr('texte'),
  number: tr('nombre'),
  select: tr('sélection'),
  multiSelect: tr('sélection multiple'),
  checkbox: tr('case à cocher'),
  date: tr('date'),
  url: tr('lien'),
  email: tr('e-mail'),
  phone: tr('téléphone'),
  rating: tr('note'),
  progress: tr('progression'),
  note: tr('note liée'),
  createdTime: tr('date de création'),
  updatedTime: tr('date de modification'),
  relation: tr('relation'),
  rollup: tr('agrégat'),
  formula: tr('formule'),
  person: tr('personne'),
  vaultFile: tr('fichier du coffre'),
};

export function Bases() {
  const { data, error } = useResource<{ bases: BaseRow[]; publicUrl: string; write: boolean }>('/bases', 10_000);
  const [sel, setSel] = useState(0);
  const [tab, setTab] = useState(0);
  const bases = data?.bases ?? [];
  const cur = bases[Math.min(sel, Math.max(0, bases.length - 1))];
  const tabs = [t("Points d'accès"), t('Schéma'), t('Aperçu des données'), t('OpenAPI')];

  const downloadOpenApi = async () => {
    const spec = await api('GET', '/openapi.json');
    download('openapi.json', JSON.stringify(spec, null, 2), 'application/json');
  };

  return (
    <>
      <div class="top">
        <div class="grow">
          <h1>{t("Bases et points d'accès")}</h1>
          <div class="sub">{t("Chaque vue de la base devient un point d'accès : ses filtres, son tri et ses colonnes font le contrat.")}</div>
        </div>
        <button class="btn" type="button" onClick={() => void downloadOpenApi()}>
          {t("Télécharger l'OpenAPI")}
        </button>
      </div>
      <ErrorNotice error={error} />
      {data && bases.length === 0 ? <div class="card empty">{t('Aucune base ouverte à ce jeton pour le moment.')}</div> : null}

      {cur ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'flex-start' }}>
          <section class="card" style={{ flex: '1 1 240px', maxWidth: '300px', padding: '10px' }} aria-label={t('Bases')}>
            {bases.map((b, i) => {
              const r = rightsLabel(b.rights);
              return (
                <button
                  type="button"
                  onClick={() => setSel(i)}
                  aria-pressed={i === sel}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px', width: '100%', border: 0, borderRadius: '8px', padding: '10px 12px', textAlign: 'left', font: 'inherit', cursor: 'pointer', background: i === sel ? '#e7eff9' : 'transparent', color: '#14233a', minHeight: '44px' }}
                >
                  <span style={{ fontWeight: 700 }}>{b.title ?? t('Base sans manifeste')}</span>
                  <span style={{ fontSize: '12.5px', color: '#526276' }}>
                    {b.slug ? `/v1/${b.slug}` : b.storeId} · {plural(b.rows ?? 0, '{n} ligne', '{n} lignes')}
                  </span>
                  <span style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    <span class={`badge ${r.cls}`}>{r.text}</span>
                    {b.status !== 'ready' ? <span class={`badge ${baseStatus(b.status).cls}`}>{baseStatus(b.status).text}</span> : null}
                  </span>
                </button>
              );
            })}
          </section>

          <div style={{ flex: '999 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div class="card" style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 24px', alignItems: 'center' }}>
              <div class="grow">
                <div style={{ fontSize: '18px', fontWeight: 700 }}>{cur.title ?? cur.storeId}</div>
                <div style={{ color: '#526276', fontSize: '13px' }}>
                  {t('magasin')} <span class="mono">{cur.storeId}</span> · {t('version')} <span class="mono">v{fmtNumber(cur.version ?? 0)}</span> ·{' '}
                  {cur.keysHeld && cur.keysHeld.length > 0
                    ? t('clés détenues {keys}', { keys: cur.keysHeld.map((k) => `(${k.e}, ${k.g})`).join(' ') })
                    : t('aucune clé détenue')}{' '}
                  · {plural(cur.blocks ?? 0, '{n} bloc', '{n} blocs')} ({fmtBytes(cur.encryptedBytes)})
                </div>
              </div>
              <span class={`badge ${rightsLabel(cur.rights).cls}`}>{rightsLabel(cur.rights).text}</span>
              <Badge cls={baseStatus(cur.status).cls} dot>
                {baseStatus(cur.status).text}
              </Badge>
            </div>
            {cur.problem ? <div class={`notice ${cur.status === 'missing_key' || cur.status === 'unverified' ? 'bad' : 'warn'}`}>{cur.problem.message}</div> : null}

            {cur.slug ? (
              <>
                <div class="tabs" role="tablist" aria-label={t('Détail de la base')}>
                  {tabs.map((label, i) => (
                    <button class={`tab ${i === tab ? 'on' : ''}`} type="button" role="tab" aria-selected={i === tab} onClick={() => setTab(i)}>
                      {label}
                    </button>
                  ))}
                </div>
                {tab === 0 ? <Endpoints base={cur} publicUrl={data!.publicUrl} write={data!.write} /> : null}
                {tab === 1 ? <Schema base={cur} /> : null}
                {tab === 2 ? <Preview base={cur} /> : null}
                {tab === 3 ? (
                  <section class="card" aria-labelledby="oa">
                    <h2 id="oa">{t('Description OpenAPI 3.1')}</h2>
                    <p class="hint">{t('Générée à partir des vues et des colonnes. Postman, n8n, Make et les générateurs de bibliothèques la lisent directement.')}</p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '14px' }}>
                      <button class="btn" type="button" onClick={() => void downloadOpenApi()}>
                        openapi.json
                      </button>
                      <a class="btn" href={`${data!.publicUrl}/docs`} target="_blank" rel="noreferrer">
                        /docs
                      </a>
                      <span class="mono" style={{ alignSelf: 'center', color: '#526276' }}>
                        {t('aussi servie sur /openapi.json')}
                      </span>
                    </div>
                  </section>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function Endpoints(props: { base: BaseRow; publicUrl: string; write: boolean }) {
  const b = props.base;
  const firstView = b.views?.find((v) => v.type !== 'query');
  const sample = firstView ? `${b.endpoint}/${firstView.slug}` : b.endpoint;
  const titleField = b.fields?.find((f) => f.type === 'text' && f.writable);
  const writable = b.methods?.includes('POST');
  return (
    <>
      <div class="table-box">
        <table>
          <thead>
            <tr>
              <th>{t('Vue dans Filarr')}</th>
              <th>{t("Point d'accès")}</th>
              <th>{t('Méthodes')}</th>
              <th>{t('Ce que la vue décide')}</th>
              <th>{t('Clés autorisées')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>{t('Toute la base')}</strong>
              </td>
              <td class="mono">{b.endpoint}</td>
              <td>
                {(b.methods ?? ['GET']).map((m) => (
                  <>
                    <span class="badge">{m}</span>{' '}
                  </>
                ))}
              </td>
              <td>{t('toutes les lignes, ordre manuel')}</td>
              <td>{(b.keys ?? []).join(', ') || '—'}</td>
            </tr>
            {(b.views ?? []).map((v) => (
              <tr>
                <td>
                  <strong>{v.name}</strong>
                  {v.type === 'query' ? <div class="muted" style={{ fontSize: '12.5px' }}>{t('vue Requête (SQL)')}</div> : null}
                </td>
                <td class="mono">{v.endpoint}</td>
                <td>
                  <span class="badge">GET</span>
                </td>
                <td class={v.type === 'query' ? 'mono' : ''} style={{ maxWidth: '320px', overflowWrap: 'anywhere' }}>
                  {decides(v.summary)}
                </td>
                <td>{v.keys.join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="grid2">
        <section class="card" aria-labelledby="lire">
          <h2 id="lire">{t('Lire')}</h2>
          <p class="hint">{t("Réponse depuis la copie en mémoire : pas d'aller-retour vers Filarr.")}</p>
          <div class="code" style={{ marginTop: '12px' }}>
            <span class="c">{t('# les deux premières lignes')}</span>
            {`\ncurl "${props.publicUrl}${sample}?limit=2" \\\n  -H `}
            <span class="s">"Authorization: Bearer gk_…"</span>
            {'\n\n{ '}
            <span class="k">"rows"</span>
            {': [ … ], '}
            <span class="k">"next"</span>
            {': '}
            <span class="s">"o2"</span>
            {', '}
            <span class="k">"version"</span>
            {`: ${b.version ?? 0} }`}
          </div>
        </section>
        <section class="card" aria-labelledby="ecrire">
          <h2 id="ecrire">{t('Écrire')}</h2>
          {writable ? (
            <>
              <p class="hint">{t("L'écriture devient un changement chiffré, validé par Filarr, visible tout de suite dans l'appli, sans conflit.")}</p>
              <div class="code" style={{ marginTop: '12px' }}>
                <span class="c">{t('# une nouvelle ligne')}</span>
                {`\ncurl -X POST "${props.publicUrl}${b.endpoint}" \\\n  -H `}
                <span class="s">"Authorization: Bearer gk_…"</span>
                {' \\\n  -H '}
                <span class="s">"Idempotency-Key: 4f1c-…"</span>
                {' \\\n  -d '}
                <span class="s">{`'{"${titleField?.name ?? 'nom'}":"…"}'`}</span>
                {'\n\n{ '}
                <span class="k">"id"</span>
                {': '}
                <span class="s">"db-…"</span>
                {', '}
                <span class="k">"version"</span>
                {`: ${(b.version ?? 0) + 1}, `}
                <span class="k">"validated"</span>
                {': '}
                <span class="k">true</span>
                {' }'}
              </div>
            </>
          ) : (
            <p class="hint">
              {!props.write
                ? t("L'écriture vers Filarr est éteinte sur cette boîte noire (Réglages › Liaison avec Filarr).")
                : t('Cet accès ne peut que lire cette base : son droit est « lecture seule » dans Filarr.')}
            </p>
          )}
        </section>
      </div>
    </>
  );
}

function Schema(props: { base: BaseRow }) {
  return (
    <>
      <div class="table-box">
        <table>
          <thead>
            <tr>
              <th>{t('Colonne')}</th>
              <th>{t('Type dans Filarr')}</th>
              <th>{t('Champ JSON')}</th>
              <th>{t('Valeurs')}</th>
              <th>{t('Écriture')}</th>
            </tr>
          </thead>
          <tbody>
            {(props.base.fields ?? []).map((f) => (
              <tr>
                <td>
                  <strong>{f.column}</strong>
                </td>
                <td>
                  {t(TYPE_FR[f.type] ?? f.type)}
                  {f.target ? (f.target.granted ? ` → ${f.target.title}` : ` → ${t('base non ouverte')}`) : ''}
                </td>
                <td class="mono">
                  {f.name} · {f.options && f.type === 'select' ? 'enum' : f.jsonType === 'string[]' ? (f.type === 'relation' ? 'id[]' : 'string[]') : f.jsonType}
                </td>
                <td>
                  {f.options ? f.options.join(', ') : f.type === 'date' ? t('AAAA-MM-JJ') : f.type === 'relation' ? t('identifiants de lignes') : !f.writable ? t('calculé') : '—'}
                  {f.unresolved ? (
                    <>
                      {' '}
                      <span class="badge warn">{t('non résolu')}</span>
                    </>
                  ) : null}
                </td>
                <td>{f.writable ? t('oui') : t('non')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ margin: 0, color: '#526276', fontSize: '13px' }}>
        {t("Les noms de champs suivent les colonnes ; renommer une colonne dans Filarr garde l'ancien nom, pour que vos logiciels ne cassent pas. Une relation vers une base que ce jeton n'ouvre pas rend les identifiants bruts, et ses agrégats valent null.")}
      </p>
    </>
  );
}

function Preview(props: { base: BaseRow }) {
  const [page, setPage] = useState<{ rows: Array<Record<string, unknown>>; total: number } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    setPage(null);
    api<{ rows: Array<Record<string, unknown>>; total: number }>('GET', `/bases/${props.base.storeId}/rows?limit=50`)
      .then(setPage)
      .catch((err) => setError(err as Error));
  }, [props.base.storeId, props.base.version]);
  const fields = (props.base.fields ?? []).slice(0, 8);
  const show = (v: unknown, f: Field): string => {
    if (v === null || v === undefined) return '—';
    if (Array.isArray(v)) return v.join(', ') || '—';
    if (typeof v === 'boolean') return v ? '✓' : '—';
    if (typeof v === 'number') return f.numberFormat === 'euro' ? `${fmtNumber(v, 2)} €` : f.numberFormat === 'percent' ? `${fmtNumber(v)} %` : fmtNumber(v);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  return (
    <>
      <ErrorNotice error={error} />
      <div class="table-box">
        <table>
          <thead>
            <tr>
              {fields.map((f) => (
                <th>{f.column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(page?.rows ?? []).map((r) => (
              <tr>
                {fields.map((f) => (
                  <td>{f.type === 'select' && r[f.name] ? <span class="badge grey">{String(r[f.name])}</span> : show(r[f.name], f)}</td>
                ))}
              </tr>
            ))}
            {page && page.rows.length === 0 ? (
              <tr>
                <td colSpan={fields.length || 1} class="empty">
                  {t('Base vide')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p style={{ margin: 0, color: '#526276', fontSize: '13px', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
        {t("Déchiffré sur cette machine. Rien de ce tableau n'est passé en clair chez Filarr.")}
        {page ? <span>{t('{shown} lignes montrées sur {total}', { shown: fmtNumber(page.rows.length), total: fmtNumber(page.total) })}</span> : null}
        <CopyButton text={props.base.endpoint ?? ''} label={t("Copier le point d'accès")} />
      </p>
    </>
  );
}
