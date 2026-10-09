/** 4 · Explorateur SQL. */

import { useState } from 'preact/hooks';
import { api, download } from '../api';
import { ErrorNotice, useResource } from '../components';
import { fmtNumber, plural, t } from '../i18n';
import { csv, xlsx } from '../xlsx';

interface SqlResult {
  columns: string[];
  rows: unknown[][];
  ms: number;
  scanned: number;
  truncated: boolean;
}

interface Tables {
  tables: Array<{ name: string; entity: string | null; rows: number; columns: Array<{ name: string; kind: string; references: string | null }> }>;
}

interface Query {
  id: string;
  name: string;
  slug: string;
  sql: string;
  endpoint: string;
  keys: string[];
}

const EXAMPLE = 'SELECT *\nFROM ';

export function Explorer() {
  const tables = useResource<Tables>('/sql/tables', 30_000);
  const queries = useResource<{ queries: Query[] }>('/queries');
  const first = tables.data?.tables.find((x) => x.entity)?.name;
  const [sql, setSql] = useState<string | null>(null);
  const text = sql ?? `${EXAMPLE}${first ?? ''}\nLIMIT 50`;
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Query | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api<SqlResult>('POST', '/sql', { sql: text }));
    } catch (err) {
      setResult(null);
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const name = window.prompt(t('Nom de la requête (il donne le chemin /v1/q/…)'));
    if (!name) return;
    try {
      const q = await api<Query>('POST', '/queries', { name, sql: text });
      setSaved({ ...q, endpoint: `/v1/q/${q.slug}`, keys: [] });
      await queries.reload();
    } catch (err) {
      setError(err as Error);
    }
  };

  const exportAs = (kind: 'csv' | 'json' | 'xlsx') => {
    if (!result) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    if (kind === 'csv') download(`requete-${stamp}.csv`, csv(result.columns, result.rows), 'text/csv;charset=utf-8');
    if (kind === 'json')
      download(`requete-${stamp}.json`, JSON.stringify(result.rows.map((r) => Object.fromEntries(result.columns.map((c, i) => [c, r[i]]))), null, 2), 'application/json');
    if (kind === 'xlsx') download(`requete-${stamp}.xlsx`, xlsx(result.columns, result.rows) as unknown as BlobPart, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  };

  const shown = saved ?? queries.data?.queries[queries.data.queries.length - 1] ?? null;

  return (
    <>
      <div class="top">
        <div class="grow">
          <h1>{t('Explorateur SQL')}</h1>
          <div class="sub">{t("Le moteur SQL de Filarr, sur la copie déchiffrée. Lecture seule : les écritures passent par les points d'accès.")}</div>
        </div>
        <span class="badge grey">{t('SELECT, jointures, regroupements')}</span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'flex-start' }}>
        <div style={{ flex: '999 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <section class="card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }} aria-labelledby="req">
            <h2 id="req">{t('Requête')}</h2>
            <label for="sql" class="sr-only">
              {t('Texte SQL')}
            </label>
            <textarea
              id="sql"
              class="mono"
              rows={7}
              spellcheck={false}
              style={{ width: '100%', border: '1px solid #cfd8e3', borderRadius: '10px', padding: '12px 14px', fontSize: '13px', lineHeight: 1.6, color: '#14233a', resize: 'vertical' }}
              value={text}
              onInput={(e) => setSql((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void run();
                }
              }}
            />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
              <button class="btn primary" type="button" disabled={busy} onClick={() => void run()}>
                {t('Exécuter')}
              </button>
              <span class="mono" style={{ color: '#526276' }}>
                Ctrl+Entrée
              </span>
              <span class="grow" />
              <button class="btn" type="button" onClick={() => void save()}>
                {t("Enregistrer comme point d'accès")}
              </button>
            </div>
          </section>

          <ErrorNotice error={error} />
          {result ? (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
                <span class="badge ok">
                  <span class="dot" />
                  {plural(result.rows.length, '{n} ligne', '{n} lignes')} · {t('{n} lignes parcourues en {ms} ms', { n: fmtNumber(result.scanned), ms: fmtNumber(result.ms, 1) })}
                </span>
                {result.truncated ? <span class="badge warn">{t('résultat tronqué à 10 000 lignes')}</span> : null}
                <span class="grow" />
                <button class="btn small" type="button" onClick={() => exportAs('csv')}>
                  CSV (;)
                </button>
                <button class="btn small" type="button" onClick={() => exportAs('json')}>
                  JSON
                </button>
                <button class="btn small" type="button" onClick={() => exportAs('xlsx')}>
                  Excel
                </button>
              </div>
              <div class="table-box">
                <table>
                  <thead>
                    <tr>
                      {result.columns.map((c) => (
                        <th>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.slice(0, 500).map((r) => (
                      <tr>
                        {r.map((v) => (
                          <td class={typeof v === 'number' ? 'mono' : ''}>{v === null ? '—' : typeof v === 'number' ? fmtNumber(v) : String(v)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          {shown ? (
            <section class="card" aria-labelledby="ep">
              <h2 id="ep">{t("Devenue point d'accès")}</h2>
              <p class="hint">{t('Une requête enregistrée se sert comme une vue, mise à jour à chaque changement de la base.')}</p>
              <div class="code" style={{ marginTop: '12px' }}>
                {`GET ${shown.endpoint}     `}
                <span class="c">
                  {shown.keys.length > 0 ? t('# lecture seule, clé « {keys} »', { keys: shown.keys.join(', ') }) : t('# lecture seule ; donnez-la à une clé dans « Clés des applications »')}
                </span>
              </div>
            </section>
          ) : null}
        </div>

        <aside class="card" style={{ flex: '1 1 260px', maxWidth: '320px' }} aria-labelledby="tables">
          <h2 id="tables">{t('Tables')}</h2>
          <p class="hint">{t('Les bases ouvertes par ce jeton, sous leur nom SQL.')}</p>
          <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '13px' }}>
            {(tables.data?.tables ?? []).map((tb) => (
              <li>
                <button
                  type="button"
                  class="mono"
                  style={{ fontWeight: 600, border: 0, background: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent)' }}
                  onClick={() => setSql(`SELECT *\nFROM ${tb.name}\nLIMIT 50`)}
                >
                  {tb.name}
                </button>{' '}
                <span class="muted">({fmtNumber(tb.rows)})</span>
                <div style={{ color: '#526276' }}>
                  {tb.columns.map((c) => (c.references ? `${c.name} → ${c.references}` : c.name)).join(', ')}
                </div>
                {!tb.entity ? <div class="muted" style={{ fontSize: '12px' }}>{t('table de liaison ou base non ouverte')}</div> : null}
              </li>
            ))}
          </ul>
          <div class="sep" style={{ margin: '16px 0' }} />
          <h2>{t('Requêtes enregistrées')}</h2>
          <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px' }}>
            {(queries.data?.queries ?? []).map((q) => (
              <li style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                <a
                  href="#/sql"
                  onClick={(e) => {
                    e.preventDefault();
                    setSql(q.sql);
                    setSaved(q);
                  }}
                >
                  {q.name}
                </a>
                <span class="mono muted grow">/v1/q/{q.slug}</span>
                <button
                  type="button"
                  class="btn small danger"
                  aria-label={t('Supprimer {name}', { name: q.name })}
                  onClick={async () => {
                    if (!window.confirm(t('Supprimer la requête « {name} » ? Son point d’accès cessera de répondre.', { name: q.name }))) return;
                    await api('DELETE', `/queries/${q.id}`);
                    if (saved?.id === q.id) setSaved(null);
                    await queries.reload();
                  }}
                >
                  ×
                </button>
              </li>
            ))}
            {queries.data && queries.data.queries.length === 0 ? <li class="muted">{t('Aucune pour le moment.')}</li> : null}
          </ul>
        </aside>
      </div>
    </>
  );
}
