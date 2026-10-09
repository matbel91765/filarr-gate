/** 2 · Tableau de bord. */

import { Badge, baseStatus, ErrorNotice, linkLabel, Meter, rightsLabel, useResource } from '../components';
import { fmtAgo, fmtBytes, fmtCompact, fmtDate, fmtNumber, plural, t } from '../i18n';

interface Counter {
  used: number;
  max: number;
}

interface DashboardData {
  link: { state: string; detail: string | null; lastChangeAt: string | null };
  access: { name: string | null; tier: string | null; expiresAt: string | null } | null;
  publicUrl: string;
  requests24h: number;
  medianMs: number | null;
  rows: number;
  encryptedBytes: number;
  writes24h: number;
  conflicts: number;
  webhooks: { delivered24h: number; retrying: number; abandoned24h: number };
  traffic: number[];
  health: { expiresAt: string | null; maxEpoch: number; maxGeneration: number; cache: { kind: string; location: string | null }; version: string };
  bases: Array<{ storeId: string; slug: string; title: string; views: number; rights: string; rows: number; version: number; lastChange: string | null; status: string; problem: string | null }>;
  quota: { sync?: Counter; bytes?: Counter; writes?: Counter } | null;
}

const pct = (c?: Counter) => (c && c.max > 0 ? (c.used / c.max) * 100 : 0);

export function Dashboard() {
  const { data: d, error } = useResource<DashboardData>('/dashboard', 5000);
  const link = linkLabel(d?.link.state);
  const max = Math.max(1, ...(d?.traffic ?? [0]));
  const now = new Date();
  const hm = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toTimeString().slice(0, 5);
  const ms = d?.medianMs;

  return (
    <>
      <div class="top">
        <div class="grow">
          <h1>{t('Tableau de bord')}</h1>
          <div class="sub">{t('Tout se déchiffre ici, sur votre serveur. Filarr ne voit que des blocs chiffrés.')}</div>
        </div>
        <Badge cls={link.cls} dot>
          {link.text}
          {d?.link.lastChangeAt ? ` · ${t('dernier changement {ago}', { ago: fmtAgo(d.link.lastChangeAt) })}` : ''}
        </Badge>
        <a class="btn" href="#/journal">
          {t('Voir le journal')}
        </a>
        <a class="btn primary" href="#/bases">
          {t("Ouvrir les points d'accès")}
        </a>
      </div>
      <ErrorNotice error={error} />
      {d && !['live', 'polling', 'connecting'].includes(d.link.state) && d.link.detail ? <div class={`notice ${link.cls === 'bad' ? 'bad' : 'warn'}`}>{d.link.detail}</div> : null}

      <div class="grid4">
        <div class="card">
          <div class="stat-label">{t('Requêtes servies (24 h)')}</div>
          <div class="stat-value">{fmtNumber(d?.requests24h)}</div>
          <div class="stat-foot">{t('lues en mémoire · médiane {ms} ms', { ms: ms === null || ms === undefined ? '—' : fmtNumber(ms, 1) })}</div>
        </div>
        <div class="card">
          <div class="stat-label">{t('Bases répliquées')}</div>
          <div class="stat-value">{fmtNumber(d?.bases.length)}</div>
          <div class="stat-foot">
            {plural(d?.rows ?? 0, '{n} ligne', '{n} lignes')} · {t('{bytes} chiffrés reçus', { bytes: fmtBytes(d?.encryptedBytes) })}
          </div>
        </div>
        <div class="card">
          <div class="stat-label">{t('Écritures vers Filarr (24 h)')}</div>
          <div class="stat-value">{fmtNumber(d?.writes24h)}</div>
          <div class="stat-foot">{t('{n} conflit(s) rejoué(s) · validées par le serveur', { n: fmtNumber(d?.conflicts ?? 0) })}</div>
        </div>
        <div class="card">
          <div class="stat-label">{t('Webhooks livrés (24 h)')}</div>
          <div class="stat-value">{fmtNumber(d?.webhooks.delivered24h)}</div>
          <div class="stat-foot">
            {d && d.webhooks.retrying > 0 ? (
              <span style={{ color: '#8f5200', fontWeight: 600 }}>{t('{n} en reprise', { n: fmtNumber(d.webhooks.retrying) })}</span>
            ) : (
              t('{n} en reprise', { n: 0 })
            )}{' '}
            · {t('{n} abandon(s)', { n: fmtNumber(d?.webhooks.abandoned24h ?? 0) })}
          </div>
        </div>
      </div>

      <div class="grid2" style={{ gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)' }}>
        <section class="card" aria-labelledby="trafic">
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }}>
            <h2 id="trafic" class="grow">
              {t('Trafic local, dernière heure')}
            </h2>
            <span class="badge grey">{t('requêtes / minute')}</span>
          </div>
          <p class="hint">{t('Ces requêtes ne sortent jamais de votre réseau : la boîte noire répond depuis sa copie déchiffrée.')}</p>
          <div class="spark" style={{ marginTop: '16px' }} role="img" aria-label={t('Requêtes par minute sur la dernière heure')}>
            {(d?.traffic ?? new Array(60).fill(0)).map((n, i, all) => (
              <span class={i === all.length - 1 ? 'hi' : ''} style={{ height: `${Math.max(2, (n / max) * 100)}%` }} title={`${n}`} />
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#526276', fontSize: '12px', marginTop: '6px' }}>
            <span>{hm(59)}</span>
            <span>{hm(30)}</span>
            <span>{hm(0)}</span>
          </div>
        </section>

        <section class="card" aria-labelledby="sante">
          <h2 id="sante">{t('Santé de la boîte noire')}</h2>
          <dl class="kv" style={{ marginTop: '12px' }}>
            <dt>{t('Liaison avec Filarr')}</dt>
            <dd>
              <Badge cls={link.cls} dot>
                {link.text}
              </Badge>
            </dd>
            <dt>{t("Jeton d'accès")}</dt>
            <dd>{d?.access ? (d.access.expiresAt ? t('valide · expire le {date}', { date: fmtDate(d.access.expiresAt) }) : t('valide · sans échéance')) : '—'}</dd>
            <dt>{t('Clés des bases')}</dt>
            <dd class="mono">{d ? t('époque {e} · génération {g}', { e: d.health.maxEpoch, g: d.health.maxGeneration }) : '—'}</dd>
            <dt>{t('Stockage local')}</dt>
            <dd>{d ? (d.health.cache.kind === 'disk' ? t('blocs chiffrés sur disque · lignes en mémoire') : t('tout en mémoire')) : '—'}</dd>
            <dt>{t('Adresse')}</dt>
            <dd class="mono">{d?.publicUrl ?? '—'}</dd>
            <dt>{t('Version')}</dt>
            <dd>{d?.health.version ?? '—'}</dd>
          </dl>
        </section>
      </div>

      <section aria-labelledby="bases">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
          <h2 id="bases" class="grow" style={{ margin: 0, fontSize: '15px' }}>
            {t('Bases ouvertes par ce jeton')}
          </h2>
          <a href="#/bases">{t('Tout gérer')}</a>
        </div>
        <div class="table-box">
          <table>
            <thead>
              <tr>
                <th>{t('Base')}</th>
                <th>{t("Points d'accès")}</th>
                <th>{t('Droits')}</th>
                <th>{t('Lignes')}</th>
                <th>{t('Version')}</th>
                <th>{t('Dernier changement')}</th>
              </tr>
            </thead>
            <tbody>
              {(d?.bases ?? []).map((b) => {
                const r = rightsLabel(b.rights);
                const st = baseStatus(b.status);
                return (
                  <tr>
                    <td>
                      <strong>{b.title}</strong>
                      <div style={{ color: '#526276', fontSize: '12.5px' }} class="mono">
                        /v1/{b.slug}
                      </div>
                    </td>
                    <td>{plural(b.views, '{n} vue', '{n} vues')}</td>
                    <td>
                      <span class={`badge ${r.cls}`}>{r.text}</span> {b.status !== 'ready' ? <span class={`badge ${st.cls}`} title={b.problem ?? ''}>{st.text}</span> : null}
                    </td>
                    <td>{fmtNumber(b.rows)}</td>
                    <td class="mono">v{fmtNumber(b.version)}</td>
                    <td>{fmtAgo(b.lastChange)}</td>
                  </tr>
                );
              })}
              {d && d.bases.length === 0 ? (
                <tr>
                  <td colSpan={6} class="empty">
                    {t('Aucune base ouverte : ouvrez une base à cet accès dans Filarr.')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section class="card" aria-labelledby="quotas">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }}>
          <h2 id="quotas" class="grow">
            {t('Ce que compte Filarr ce mois-ci')}
          </h2>
          <a href="#/limits">{t('Détail et paliers')}</a>
        </div>
        <p class="hint">{t('Seuls les échanges avec Filarr sont comptés. Les lectures servies par la boîte noire sont illimitées.')}</p>
        <div class="grid3" style={{ marginTop: '14px' }}>
          <QuotaMeter label={t('Requêtes de synchro')} c={d?.quota?.sync} fmt={fmtCompact} />
          <QuotaMeter label={t('Volume descendu')} c={d?.quota?.bytes} fmt={fmtBytes} />
          <QuotaMeter label={t('Écritures du jour')} c={d?.quota?.writes} fmt={fmtNumber} />
        </div>
      </section>
    </>
  );
}

function QuotaMeter(props: { label: string; c?: Counter; fmt: (n: number) => string }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
        <strong>{props.label}</strong>
        <span class="mono">{props.c ? `${props.fmt(props.c.used)} / ${props.fmt(props.c.max)}` : '—'}</span>
      </div>
      <Meter pct={pct(props.c)} label={props.label} />
    </div>
  );
}
