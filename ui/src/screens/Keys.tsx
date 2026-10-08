/** 5 · Clés des applications. */

import { useState } from 'preact/hooks';
import { api } from '../api';
import { CopyButton, ErrorNotice, useResource } from '../components';
import { fmtAgo, fmtDate, fmtNumber, t, tr } from '../i18n';

interface Endpoint {
  kind: 'base' | 'view' | 'query';
  path: string;
  label: string;
  storeId?: string;
  viewId?: string;
  queryId?: string;
  writable: boolean;
}

interface KeyView {
  id: string;
  name: string;
  prefix: string;
  endpoints: string;
  rights: 'read' | 'write';
  sql: boolean;
  mcp: boolean;
  rateLimit: number;
  ipAllow: string[];
  expiresAt: string | null;
  paused: boolean;
  lastUsedAt: string | null;
  lastIp: string | null;
  requests24h: number;
  state: 'active' | 'paused' | 'expired' | 'near_rate';
}

type Perm = { read: boolean; create: boolean; update: boolean; delete: boolean };

const STATE: Record<KeyView['state'], { text: string; cls: string }> = {
  active: { text: tr('active'), cls: 'ok' },
  near_rate: { text: tr('proche du débit'), cls: 'warn' },
  paused: { text: tr('en pause'), cls: 'grey' },
  expired: { text: tr('expirée'), cls: 'bad' },
};

export function Keys(props: { onChange: () => void }) {
  const { data, error, reload } = useResource<{ keys: KeyView[]; endpoints: Endpoint[]; write: boolean }>('/keys', 10_000);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [expires, setExpires] = useState('90');
  const [perms, setPerms] = useState<Record<string, Perm>>({});
  const [allRead, setAllRead] = useState(false);
  const [sql, setSql] = useState(false);
  const [mcp, setMcp] = useState(false);
  const [rate, setRate] = useState('600');
  const [ips, setIps] = useState('');
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);

  const perm = (path: string): Perm => perms[path] ?? { read: false, create: false, update: false, delete: false };
  const toggle = (path: string, what: keyof Perm) => setPerms({ ...perms, [path]: { ...perm(path), [what]: !perm(path)[what] } });

  const reset = () => {
    setName('');
    setExpires('90');
    setPerms({});
    setAllRead(false);
    setSql(false);
    setMcp(false);
    setRate('600');
    setIps('');
  };

  const create = async () => {
    setFailure(null);
    const scopes: unknown[] = [];
    if (allRead) scopes.push({ target: 'all' });
    for (const ep of data?.endpoints ?? []) {
      const p = perm(ep.path);
      if (!p.read && !p.create && !p.update && !p.delete) continue;
      if (ep.kind === 'base') scopes.push({ target: 'base', storeId: ep.storeId, read: p.read, create: p.create, update: p.update, delete: p.delete });
      if (ep.kind === 'view' && p.read) scopes.push({ target: 'view', storeId: ep.storeId, viewId: ep.viewId });
      if (ep.kind === 'query' && p.read) scopes.push({ target: 'query', queryId: ep.queryId });
    }
    try {
      const res = await api<{ key: string; record: KeyView }>('POST', '/keys', {
        name,
        scopes,
        sql,
        mcp,
        rateLimit: Number(rate) || 600,
        ipAllow: ips,
        expiresInDays: expires === 'never' ? 0 : Number(expires),
      });
      setCreated({ key: res.key, name: res.record.name });
      setOpen(false);
      reset();
      await reload();
      props.onChange();
    } catch (err) {
      setFailure(err as Error);
    }
  };

  const act = async (task: () => Promise<unknown>) => {
    try {
      await task();
      await reload();
      props.onChange();
    } catch (err) {
      setFailure(err as Error);
    }
  };

  const box = (ep: Endpoint, what: keyof Perm, label: string) =>
    what !== 'read' && (ep.kind !== 'base' || !ep.writable) ? (
      '—'
    ) : (
      <input type="checkbox" checked={perm(ep.path)[what]} aria-label={`${label} ${ep.path}`} style={{ width: '18px', height: '18px' }} onChange={() => toggle(ep.path, what)} />
    );

  return (
    <>
      <div class="top">
        <div class="grow">
          <h1>{t('Clés des applications')}</h1>
          <div class="sub">{t("Vos logiciels n'ont jamais le jeton Filarr : chacun reçoit sa clé, limitée aux points d'accès qu'il lui faut.")}</div>
        </div>
        <button class="btn primary" type="button" onClick={() => setOpen(!open)}>
          {open ? t('Fermer') : t('Nouvelle clé')}
        </button>
      </div>
      <ErrorNotice error={error ?? failure} />

      {created ? (
        <section class="card" style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderColor: '#a9c6ea' }} aria-live="polite">
          <h2>{t('Clé « {name} » créée', { name: created.name })}</h2>
          <p class="hint">{t('Copiez-la maintenant : elle ne sera plus montrée. La boîte noire n’en garde que l’empreinte.')}</p>
          <div class="secret">{created.key}</div>
          <div class="row-actions">
            <CopyButton text={created.key} />
            <button class="btn small" type="button" onClick={() => setCreated(null)}>
              {t("C'est noté")}
            </button>
          </div>
        </section>
      ) : null}

      {open ? (
        <section class="card" style={{ display: 'flex', flexDirection: 'column', gap: '16px', borderColor: '#a9c6ea' }} aria-labelledby="newkey">
          <h2 id="newkey">{t('Nouvelle clé')}</h2>
          <div class="grid2">
            <div class="field">
              <label for="kname">{t('Nom')}</label>
              <input id="kname" class="input" value={name} placeholder={t('Facturation')} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            </div>
            <div class="field">
              <label for="kexp">{t('Expire')}</label>
              <select id="kexp" class="input" value={expires} onChange={(e) => setExpires((e.target as HTMLSelectElement).value)}>
                <option value="90">{t('dans 90 jours')}</option>
                <option value="365">{t('dans 1 an')}</option>
                <option value="never">{t('jamais')}</option>
              </select>
            </div>
          </div>
          <div class="table-box">
            <table>
              <thead>
                <tr>
                  <th>{t("Point d'accès")}</th>
                  <th>{t('Lire')}</th>
                  <th>{t('Ajouter')}</th>
                  <th>{t('Modifier')}</th>
                  <th>{t('Supprimer')}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <strong>{t('Toutes les bases et vues')}</strong>
                    <div class="muted" style={{ fontSize: '12.5px' }}>
                      {t('lecture seulement, y compris les bases ouvertes plus tard')}
                    </div>
                  </td>
                  <td>
                    <input type="checkbox" checked={allRead} aria-label={t('Lire toutes les bases')} style={{ width: '18px', height: '18px' }} onChange={() => setAllRead(!allRead)} />
                  </td>
                  <td>—</td>
                  <td>—</td>
                  <td>—</td>
                </tr>
                {(data?.endpoints ?? []).map((ep) => (
                  <tr>
                    <td class="mono" title={ep.label}>
                      {ep.path}
                    </td>
                    <td>{box(ep, 'read', t('Lire'))}</td>
                    <td>{box(ep, 'create', t('Ajouter dans'))}</td>
                    <td>{box(ep, 'update', t('Modifier dans'))}</td>
                    <td>{box(ep, 'delete', t('Supprimer dans'))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data && !data.write ? <div class="notice info">{t("L'écriture vers Filarr est éteinte sur cette boîte noire : les cases Ajouter, Modifier et Supprimer apparaîtront quand elle sera allumée (Réglages).")}</div> : null}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 24px' }}>
            <label class="check">
              <input type="checkbox" checked={sql} onChange={() => setSql(!sql)} /> {t('SQL en lecture (/v1/sql) sur les bases qu’elle lit')}
            </label>
            <label class="check">
              <input type="checkbox" checked={mcp} onChange={() => setMcp(!mcp)} /> {t('Serveur MCP (assistants IA)')}
            </label>
          </div>
          <div class="grid2">
            <div class="field">
              <label for="krate">{t('Débit maximal (requêtes / minute)')}</label>
              <input id="krate" class="input mono" inputMode="numeric" value={rate} onInput={(e) => setRate((e.target as HTMLInputElement).value)} />
            </div>
            <div class="field">
              <label for="kip">{t('Adresses autorisées')}</label>
              <input id="kip" class="input mono" value={ips} placeholder={t('toutes (ou 10.0.4.0/24, …)')} onInput={(e) => setIps((e.target as HTMLInputElement).value)} />
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'flex-end' }}>
            <button
              class="btn"
              type="button"
              onClick={() => {
                setOpen(false);
                reset();
              }}
            >
              {t('Annuler')}
            </button>
            <button class="btn primary" type="button" disabled={name.trim() === ''} onClick={() => void create()}>
              {t('Créer la clé')}
            </button>
          </div>
        </section>
      ) : null}

      <div class="table-box">
        <table>
          <thead>
            <tr>
              <th>{t('Application')}</th>
              <th>{t('Clé')}</th>
              <th>{t("Points d'accès")}</th>
              <th>{t('Requêtes (24 h)')}</th>
              <th>{t('Dernier usage')}</th>
              <th>{t('État')}</th>
              <th>
                <span class="sr-only">{t('Actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(data?.keys ?? []).map((k) => {
              const st = STATE[k.state];
              const sub = k.expiresAt ? t('expire le {date}', { date: fmtDate(k.expiresAt) }) : k.ipAllow.length ? k.ipAllow.join(', ') : k.lastIp ?? t('toutes adresses');
              return (
                <tr>
                  <td>
                    <strong>{k.name}</strong>
                    <div style={{ color: '#526276', fontSize: '12.5px' }}>{sub}</div>
                  </td>
                  <td class="mono">{k.prefix}</td>
                  <td>
                    {[k.endpoints, k.sql ? 'SQL' : '', k.mcp ? 'MCP' : ''].filter(Boolean).join(', ') || '—'} · {k.rights === 'write' ? t('lecture et écriture') : t('lecture')}
                  </td>
                  <td class="mono">{fmtNumber(k.requests24h)}</td>
                  <td>{k.lastUsedAt ? fmtAgo(k.lastUsedAt) : t('jamais')}</td>
                  <td>
                    <span class={`badge ${st.cls}`}>{t(st.text)}</span>
                  </td>
                  <td>
                    <div class="row-actions">
                      {k.paused ? (
                        <button class="btn small" type="button" onClick={() => void act(() => api('PATCH', `/keys/${k.id}`, { paused: false }))}>
                          {t('Reprendre')}
                        </button>
                      ) : (
                        <button class="btn small" type="button" onClick={() => void act(() => api('PATCH', `/keys/${k.id}`, { paused: true }))}>
                          {t('Mettre en pause')}
                        </button>
                      )}
                      <button
                        class="btn small danger"
                        type="button"
                        onClick={() => {
                          if (window.confirm(t('Révoquer la clé « {name} » ? Elle cesse de répondre tout de suite.', { name: k.name }))) void act(() => api('DELETE', `/keys/${k.id}`));
                        }}
                      >
                        {t('Révoquer')}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {data && data.keys.length === 0 ? (
              <tr>
                <td colSpan={7} class="empty">
                  {t('Aucune clé : créez-en une par logiciel qui lit vos bases.')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p style={{ margin: 0, color: '#526276', fontSize: '13px' }}>
        {t('Une clé révoquée cesse de répondre tout de suite. Elle ne touche pas au jeton Filarr : pour couper la boîte noire elle-même, révoquez l’accès dans Filarr.')}
      </p>
    </>
  );
}
