/** 7 · Journal. */

import { useState } from 'preact/hooks';
import { ErrorNotice, useResource } from '../components';
import { fmtNumber, fmtTime, t, tr } from '../i18n';

interface Entry {
  at: string;
  kind: 'read' | 'write' | 'error' | 'filarr' | 'admin';
  who: string;
  what: string;
  code: string;
  ms?: number;
  note?: string;
}

const DEFS: Array<[string, string]> = [
  ['all', tr('Tout')],
  ['read', tr('Lectures')],
  ['write', tr('Écritures')],
  ['error', tr('Refus et erreurs')],
  ['filarr', 'Filarr'],
  ['admin', tr('Administration')],
];

function codeClass(e: Entry): string {
  const n = Number(e.code);
  if (Number.isFinite(n)) return n >= 500 ? 'bad' : n === 429 || n === 409 ? 'warn' : n >= 400 ? 'bad' : 'ok';
  return e.kind === 'error' ? 'bad' : '';
}

export function Journal() {
  const [kind, setKind] = useState('all');
  const [q, setQ] = useState('');
  const { data, error } = useResource<{ entries: Entry[]; counts: Record<string, number>; retentionDays: number }>(
    `/journal?kind=${kind}&q=${encodeURIComponent(q)}&limit=300`,
    5000
  );
  return (
    <>
      <div class="top">
        <div class="grow">
          <h1>{t('Journal')}</h1>
          <div class="sub">
            {t('Chaque requête servie et chaque échange avec Filarr. Gardé {days} jours sur cette machine, jamais envoyé ailleurs.', { days: data?.retentionDays ?? 30 })}
          </div>
        </div>
        <a class="btn" href="/admin/api/journal/export" download>
          {t('Exporter (JSON Lines)')}
        </a>
      </div>
      <ErrorNotice error={error} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }} role="group" aria-label={t('Filtrer le journal')}>
        {DEFS.map(([id, label]) => (
          <button type="button" class={`chip ${id === kind ? 'on' : ''}`} aria-pressed={id === kind} onClick={() => setKind(id)}>
            {t(label)} · {fmtNumber(data?.counts[id] ?? 0)}
          </button>
        ))}
        <span class="grow" />
        <label for="q" class="sr-only">
          {t('Chercher dans le journal')}
        </label>
        <input id="q" class="input" style={{ maxWidth: '280px' }} placeholder={t('clé, chemin, code…')} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      </div>
      <div class="table-box">
        <table>
          <thead>
            <tr>
              <th>{t('Heure')}</th>
              <th>{t('Source')}</th>
              <th>{t('Action')}</th>
              <th>{t('Résultat')}</th>
              <th>{t('Durée')}</th>
              <th>{t('Détail')}</th>
            </tr>
          </thead>
          <tbody>
            {(data?.entries ?? []).map((r) => (
              <tr>
                <td class="mono nowrap" title={r.at}>
                  {fmtTime(r.at)}
                </td>
                <td>{r.who === 'Filarr' ? 'Filarr' : r.who}</td>
                <td class="mono" style={{ overflowWrap: 'anywhere' }}>
                  {r.what}
                </td>
                <td>
                  <span class={`badge ${codeClass(r)}`}>{r.code}</span>
                </td>
                <td class="mono">{r.ms === undefined ? '' : `${fmtNumber(r.ms, r.ms < 10 ? 1 : 0)} ms`}</td>
                <td style={{ color: '#526276' }}>{r.note ?? ''}</td>
              </tr>
            ))}
            {data && data.entries.length === 0 ? (
              <tr>
                <td colSpan={6} class="empty">
                  {t('Rien pour ce filtre.')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p style={{ margin: 0, color: '#526276', fontSize: '13px' }}>
        {t('Les lignes « Filarr » viennent de la liaison chiffrée : synchro des blocs, rescellement des clés, refus de quota. Le reste ne quitte pas votre réseau.')}
      </p>
    </>
  );
}
