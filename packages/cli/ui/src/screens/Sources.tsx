/**
 * Sources · les synchros externes que Filarr confie à cette boîte noire
 * (`source-externe-1` § 7.2, § 14) : pour chaque définition qui la désigne, son
 * connecteur, son hôte, son sens, son signataire, son état ; la clé de la base
 * externe se donne ICI (jamais par Filarr). La file « me demander » se lit ici et
 * se tranche depuis Filarr.
 */

import { useState } from 'preact/hooks';
import { api } from '../api';
import { Badge, ErrorNotice, useResource } from '../components';
import { fmtAgo, fmtDate, fmtNumber, t, tr } from '../i18n';

interface SourceView {
  defId: string;
  rev: number;
  name: string;
  base: string | null;
  connector: string;
  host: string;
  mode: string;
  every: string | null;
  signer: string;
  blocked: string | null;
  detail: string | null;
  key: { source: 'env' | 'state' | null; env: string };
  paused: boolean;
  lastRunAt: string | null;
  lastOkAt: string | null;
  nextRunAt: string | null;
  failures: number;
  running: boolean;
  status: null | {
    state: string;
    code: string | null;
    counts: { rows: number; in: { changed: number; created: number; gone: number }; out: { changed: number; inserted: number; deleted: number }; conflicts: number };
    queue: { n: number; overflow: number };
    question: Record<string, unknown> | null;
    columns: Array<{ col: string; status: string }>;
    journal: Array<{ at: string; kind: string; row?: string; col?: string; code?: string }>;
  };
}

interface SourcesData {
  enabled: boolean;
  creator: string;
  sources: SourceView[];
}

const MODES: Record<string, string> = { mirror: tr('miroir entrant'), publish: tr('publication sortante'), both: tr('dans les deux sens'), once: tr('import ponctuel') };
const EVERY: Record<string, string> = { manual: tr('à la demande'), '15m': tr('toutes les 15 min'), '1h': tr('toutes les heures'), '1d': tr('chaque jour') };

/** Ce qui empêche une synchro de tourner, en mots (codes du contrat, liste ouverte). */
function blockedText(code: string | null): string {
  switch (code) {
    case null:
      return t('prête');
    case 'extdb_key_missing':
      return t('clé manquante');
    case 'extdb_unsigned':
      return t('en attente de la signature du créateur');
    case 'extdb_tier':
      return t('palier insuffisant (Solo et plus)');
    case 'extdb_def_newer':
      return t('définition plus récente que cette version');
    case 'extdb_policy_missing':
      return t('politique de conflit à choisir dans Filarr');
    case 'extdb_def_invalid':
      return t('définition invalide');
    case 'extdb_unreachable':
      return t('connecteur indisponible ici');
    case 'paused':
      return t('en pause');
    default:
      return code;
  }
}

function stateBadge(s: SourceView) {
  if (s.running) return <Badge cls="grey">{t('en cours')}</Badge>;
  if (s.blocked) return <Badge cls={s.blocked === 'paused' ? 'grey' : 'warn'}>{blockedText(s.blocked)}</Badge>;
  const st = s.status;
  if (!st) return <Badge cls="grey">{t('jamais lancée')}</Badge>;
  if (st.state === 'ok' && st.queue.n > 0) return <Badge cls="warn">{t('{n} conflits à trancher', { n: st.queue.n })}</Badge>;
  if (st.state === 'ok') return <Badge cls="ok">{t('à jour')}</Badge>;
  if (st.state === 'question') return <Badge cls="warn">{t('question posée dans Filarr')}</Badge>;
  return <Badge cls="bad">{st.code ?? st.state}</Badge>;
}

function KeyForm(props: { source: SourceView; onDone: () => void }) {
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const id = `key-${props.source.defId}`;
  const save = async (value: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await api('PUT', `/sources/${props.source.defId}/key`, { secret: value });
      setSecret('');
      props.onDone();
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };
  if (props.source.key.source === 'env') {
    return <p class="hint">{t('Clé donnée par l’environnement ou gate.toml ({env}).', { env: props.source.key.env })}</p>;
  }
  return (
    <form
      class="field"
      onSubmit={(e) => {
        e.preventDefault();
        void save(secret);
      }}
    >
      <label for={id}>{t('Clé de {host}', { host: props.source.host })}</label>
      <div style={{ display: 'flex', gap: '8px' }}>
        <input id={id} class="input mono" type="password" autoComplete="off" value={secret} placeholder={props.source.key.source === 'state' ? t('clé enregistrée (chiffrée)') : t('jeton, mot de passe ou JSON du compte de service')} onInput={(e) => setSecret((e.target as HTMLInputElement).value)} />
        <button class="btn" type="submit" disabled={busy || secret === ''}>
          {t('Enregistrer')}
        </button>
        {props.source.key.source === 'state' ? (
          <button class="btn" type="button" disabled={busy} onClick={() => void save(null)}>
            {t('Retirer')}
          </button>
        ) : null}
      </div>
      <p class="hint">{t('Rangée chiffrée sur cette machine, jamais envoyée à Filarr. Variable possible : {env}.', { env: props.source.key.env })}</p>
      <ErrorNotice error={error} />
    </form>
  );
}

export function Sources() {
  const { data, error, reload } = useResource<SourcesData>('/sources', 5000);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const act = async (s: SourceView, what: 'run' | 'pause' | 'resume') => {
    setBusy(s.defId);
    setActionError(null);
    try {
      if (what === 'run') await api('POST', `/sources/${s.defId}/run`, {});
      else await api('POST', `/sources/${s.defId}/pause`, { paused: what === 'pause' });
      await reload();
    } catch (err) {
      setActionError(err as Error);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <div class="top">
        <div class="grow">
          <h1>{t('Sources')}</h1>
          <div class="sub">{t('Les bases externes que Filarr confie à cette boîte noire. Elle les synchronise à la fréquence choisie dans Filarr, avec la clé donnée ici.')}</div>
        </div>
      </div>
      <ErrorNotice error={error ?? actionError} />
      {data && data.creator !== 'authenticated' ? (
        <div class="notice warn" role="note">
          {t('La clé du créateur de l’accès n’est pas authentifiée : aucune synchro ne s’exécute. Remplacez le jeton depuis Filarr (bureau ou web).')}
        </div>
      ) : null}
      {data && data.sources.length === 0 ? <div class="empty">{t('Aucune synchro ne désigne cette boîte noire. Elles se créent dans Filarr : « ··· » d’une base › « Alimenter depuis une base externe… ».')}</div> : null}
      {(data?.sources ?? []).map((s) => (
        <section class="card" aria-labelledby={`src-${s.defId}`}>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <h2 id={`src-${s.defId}`} class="grow" style={{ margin: 0 }}>
              {s.name}
            </h2>
            {stateBadge(s)}
            <button class="btn small" type="button" disabled={busy === s.defId || !!s.blocked || s.running} onClick={() => void act(s, 'run')}>
              {t('Lancer maintenant')}
            </button>
            <button class="btn small" type="button" disabled={busy === s.defId} onClick={() => void act(s, s.paused ? 'resume' : 'pause')}>
              {s.paused ? t('Reprendre') : t('Mettre en pause')}
            </button>
          </div>
          <dl class="kv">
            <dt>{t('Base')}</dt>
            <dd class="mono">{s.base ?? '—'}</dd>
            <dt>{t('Connecteur')}</dt>
            <dd class="mono">
              {s.connector} · {s.host}
            </dd>
            <dt>{t('Sens')}</dt>
            <dd>{t(MODES[s.mode] ?? s.mode)}</dd>
            <dt>{t('Fréquence')}</dt>
            <dd>{s.every ? t(EVERY[s.every] ?? s.every) : '—'}</dd>
            <dt>{t('Signée par')}</dt>
            <dd class="mono">
              {s.signer} · {t('révision {rev}', { rev: s.rev })}
            </dd>
            <dt>{t('Dernier passage')}</dt>
            <dd>
              {fmtAgo(s.lastRunAt)}
              {s.lastOkAt && s.lastOkAt !== s.lastRunAt ? ` · ${t('dernier réussi {when}', { when: fmtAgo(s.lastOkAt) })}` : ''}
            </dd>
            <dt>{t('Prochain passage')}</dt>
            <dd>{s.nextRunAt ? fmtDate(s.nextRunAt, true) : t('à la demande')}</dd>
            {s.status ? (
              <>
                <dt>{t('Lignes')}</dt>
                <dd>
                  {t('{rows} lignes · vers Filarr {inn} · vers la source {out}', {
                    rows: fmtNumber(s.status.counts.rows),
                    inn: fmtNumber(s.status.counts.in.changed + s.status.counts.in.created),
                    out: fmtNumber(s.status.counts.out.changed + s.status.counts.out.inserted + s.status.counts.out.deleted),
                  })}
                </dd>
              </>
            ) : null}
          </dl>
          {s.detail ? <p class="hint">{s.detail}</p> : null}
          {s.status?.queue.n ? <p class="hint">{t('{n} conflits attendent votre décision : ils se tranchent dans Filarr. Ces cellules gardent leur valeur dans Filarr jusque-là ; le reste se synchronise.', { n: s.status.queue.n })}</p> : null}
          {s.status?.columns.length ? <p class="hint">{t('Colonnes instables (elles ne sortent plus) : {cols}', { cols: s.status.columns.map((c) => c.col).join(', ') })}</p> : null}
          <KeyForm source={s} onDone={() => void reload()} />
          {s.status?.journal.length ? (
            <details>
              <summary>{t('Journal de la synchro')}</summary>
              <div class="table-box">
                <table>
                  <tbody>
                    {[...s.status.journal].reverse().slice(0, 30).map((j) => (
                      <tr>
                        <td class="mono nowrap">{fmtAgo(j.at)}</td>
                        <td class="mono">{j.kind}</td>
                        <td class="mono">{[j.row, j.col].filter(Boolean).join(' · ')}</td>
                        <td class="mono">{j.code ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </section>
      ))}
    </>
  );
}
