/** 6 · Webhooks. */

import { useState } from 'preact/hooks';
import { api } from '../api';
import { CopyButton, ErrorNotice, useResource } from '../components';
import { fmtNumber, fmtTime, t, tr } from '../i18n';

interface Delivery {
  id: string;
  event: string;
  label: string;
  at: string;
  attempt: number;
  status: number | null;
  ms: number | null;
  error?: string;
  nextAt?: string;
  final: boolean;
  body?: string;
}

interface Hook {
  id: string;
  name: string;
  url: string;
  secretSuffix: string;
  target: { storeId: string; viewId: string | null; base: string | null; baseSlug: string | null; view: string | null } | null;
  events: string[];
  filter: string | null;
  transition: boolean;
  fields: string[] | null;
  expand: string[];
  paused: boolean;
  pending: number;
  delivered24h: number;
  last: Delivery | null;
  deliveries: Delivery[];
}

interface Data {
  webhooks: Hook[];
  stats: { delivered24h: number; retrying: number; abandoned24h: number };
  bases: Array<{ storeId: string; title: string; slug: string; fields: Array<{ name: string; relation: boolean }>; views: Array<{ id: string; name: string; slug: string }> }>;
}

const EVENT_TEXT: Record<string, string> = {
  'row.created': tr('Ligne ajoutée'),
  'row.updated': tr('Ligne modifiée'),
  'row.deleted': tr('Ligne supprimée'),
  'gate.quota': tr('Avis de quota de Filarr'),
};

function trigger(h: Hook): string {
  const events = h.events.map((e) => t(EVENT_TEXT[e] ?? e)).join(', ');
  if (!h.target) return events;
  return t('{events} dans {base}', { events, base: h.target.view ? `${h.target.base} · ${h.target.view}` : (h.target.base ?? '?') });
}

function statusOf(d: Delivery | null): { text: string; cls: string } {
  if (!d) return { text: t('aucune livraison'), cls: 'grey' };
  if (d.status === null && !d.final && !d.error) return { text: t('en cours'), cls: 'grey' };
  const code = d.status === null ? t('erreur') : String(d.status);
  if (d.status !== null && d.status >= 200 && d.status < 300) return { text: `${code} · ${fmtNumber(d.ms ?? 0)} ms`, cls: 'ok' };
  if (d.nextAt) return { text: t('{code} · nouvel essai à {time}', { code, time: fmtTime(d.nextAt) }), cls: 'warn' };
  return { text: t('{code} · abandon', { code }), cls: 'bad' };
}

export function Webhooks(props: { onChange: () => void }) {
  const { data, error, reload } = useResource<Data>('/webhooks', 5000);
  const [sel, setSel] = useState(0);
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const hooks = data?.webhooks ?? [];
  const cur = hooks[Math.min(sel, Math.max(0, hooks.length - 1))];

  const act = async (task: () => Promise<unknown>) => {
    setFailure(null);
    try {
      await task();
      await reload();
      props.onChange();
    } catch (err) {
      setFailure(err as Error);
    }
  };

  return (
    <>
      <div class="top">
        <div class="grow">
          <h1>{t('Webhooks')}</h1>
          <div class="sub">{t('Quand une ligne change dans Filarr, la boîte noire la déchiffre et prévient vos logiciels. Le contenu ne passe jamais en clair par Filarr.')}</div>
        </div>
        <button class="btn primary" type="button" onClick={() => setCreating(!creating)}>
          {creating ? t('Fermer') : t('Nouveau webhook')}
        </button>
      </div>
      <ErrorNotice error={error ?? failure} />
      {creating && data ? (
        <NewHook
          bases={data.bases}
          onCreated={async (s) => {
            setCreating(false);
            setSecret(s);
            await reload();
            setSel(hooks.length);
            props.onChange();
          }}
          onError={setFailure}
        />
      ) : null}
      {secret ? (
        <section class="card" style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderColor: '#a9c6ea' }}>
          <h2>{t('Secret de signature')}</h2>
          <p class="hint">{t('Gardez-le chez le destinataire : il vérifie chaque livraison. Il ne sera plus montré en entier.')}</p>
          <div class="secret">{secret}</div>
          <div class="row-actions">
            <CopyButton text={secret} />
            <button class="btn small" type="button" onClick={() => setSecret(null)}>
              {t("C'est noté")}
            </button>
          </div>
        </section>
      ) : null}
      {data && hooks.length === 0 && !creating ? <div class="card empty">{t('Aucun webhook : « Nouveau webhook » pour prévenir un logiciel quand une ligne change.')}</div> : null}

      {cur ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 300px', maxWidth: '400px', display: 'flex', flexDirection: 'column', gap: '10px' }} role="list" aria-label={t('Webhooks')}>
            {hooks.map((h, i) => {
              const state = h.paused ? { text: t('en pause'), cls: 'grey' } : h.pending > 0 ? { text: t('{n} en reprise', { n: h.pending }), cls: 'warn' } : { text: t('actif'), cls: 'ok' };
              return (
                <button type="button" role="listitem" class={`hook ${i === sel ? 'on' : ''}`} onClick={() => setSel(i)}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <strong class="grow">{h.name}</strong>
                    <span class={`badge ${state.cls}`}>{state.text}</span>
                  </span>
                  <span class="mono" style={{ color: '#526276', overflowWrap: 'anywhere' }}>
                    {h.url}
                  </span>
                  <span style={{ fontSize: '13px' }}>{trigger(h)}</span>
                  <span style={{ fontSize: '12.5px', color: '#526276' }}>{t('{n} livrés en 24 h · {p} en reprise', { n: fmtNumber(h.delivered24h), p: h.pending })}</span>
                </button>
              );
            })}
          </div>

          <div style={{ flex: '999 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <section class="card" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }} aria-labelledby="hookname">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
                <h2 id="hookname" class="grow" style={{ margin: 0 }}>
                  {cur.name}
                </h2>
                <button class="btn small" type="button" onClick={() => void act(() => api('POST', `/webhooks/${cur.id}/test`))}>
                  {t('Envoyer un essai')}
                </button>
                <button class="btn small" type="button" onClick={() => void act(() => api('PATCH', `/webhooks/${cur.id}`, { paused: !cur.paused }))}>
                  {cur.paused ? t('Reprendre') : t('Mettre en pause')}
                </button>
                <button
                  class="btn small danger"
                  type="button"
                  onClick={() => {
                    if (window.confirm(t('Supprimer le webhook « {name} » ?', { name: cur.name }))) void act(() => api('DELETE', `/webhooks/${cur.id}`));
                  }}
                >
                  {t('Supprimer')}
                </button>
              </div>
              <dl class="kv">
                <dt>{t('Déclencheur')}</dt>
                <dd>{trigger(cur)}</dd>
                <dt>{t('Filtre')}</dt>
                <dd class="mono">{cur.filter ? `${cur.transition ? t('devient vrai : ') : ''}${cur.filter}` : '—'}</dd>
                <dt>{t('Champs envoyés')}</dt>
                <dd>
                  {cur.fields ? cur.fields.join(', ') : t('toute la ligne')}
                  {cur.expand.length ? `, ${t('relations résolues ({list})', { list: cur.expand.join(', ') })}` : ''}
                </dd>
                <dt>{t('Signature')}</dt>
                <dd>
                  HMAC-SHA256, {t('secret')} <span class="mono">whsec_…{cur.secretSuffix}</span>{' '}
                  <a
                    href="#/webhooks"
                    onClick={(e) => {
                      e.preventDefault();
                      if (!window.confirm(t('Renouveler le secret ? Le destinataire devra recevoir le nouveau.'))) return;
                      void act(async () => setSecret((await api<{ secret: string }>('POST', `/webhooks/${cur.id}/rotate`)).secret));
                    }}
                  >
                    {t('renouveler')}
                  </a>
                </dd>
                <dt>{t('Reprises')}</dt>
                <dd>{t('8 essais sur environ 10 h 30, délai doublé à chaque échec, puis abandon noté au journal')}</dd>
              </dl>
            </section>

            <section class="card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }} aria-labelledby="last">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
                <h2 id="last" class="grow" style={{ margin: 0 }}>
                  {t('Dernière livraison')}
                </h2>
                <span class={`badge ${statusOf(cur.last).cls}`}>{statusOf(cur.last).text}</span>
              </div>
              {cur.last?.body ? (
                <div class="code">
                  {`POST ${cur.url}\nFilarr-Gate-Event: ${cur.last.event}\nFilarr-Gate-Delivery: ${cur.last.id}\nFilarr-Gate-Signature: t=…,v1=…\n\n${JSON.stringify(JSON.parse(cur.last.body), null, 2)}`}
                </div>
              ) : (
                <div class="empty">{t('Rien n’est encore parti.')}</div>
              )}
              <p class="hint">
                {t('Vérifiez la signature sur le corps brut, avant de le lire :')} <span class="mono">v1 = HMAC(secret, t + "." + corps)</span>. {t('Un horodatage de plus de 5 minutes se refuse.')}
              </p>
            </section>

            <div class="table-box">
              <table>
                <thead>
                  <tr>
                    <th>{t('Envoi')}</th>
                    <th>{t('Événement')}</th>
                    <th>{t('Ligne')}</th>
                    <th>{t('Réponse')}</th>
                    <th>{t('Durée')}</th>
                    <th>{t('Essai')}</th>
                  </tr>
                </thead>
                <tbody>
                  {cur.deliveries.map((d) => {
                    const ok = d.status !== null && d.status >= 200 && d.status < 300;
                    return (
                      <tr>
                        <td class="mono">{fmtTime(d.at)}</td>
                        <td class="mono">{d.event}</td>
                        <td>{d.label}</td>
                        <td>
                          <span class={`badge ${ok ? 'ok' : d.status === null ? (d.error ? 'bad' : 'grey') : d.status === 429 ? 'warn' : 'bad'}`} title={d.error ?? ''}>
                            {d.status ?? (d.error ? t('erreur') : '…')}
                          </span>
                        </td>
                        <td class="mono">{d.ms === null ? '—' : `${fmtNumber(d.ms)} ms`}</td>
                        <td>{d.attempt}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function NewHook(props: { bases: Data['bases']; onCreated: (secret: string | null) => void | Promise<void>; onError: (e: Error) => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('https://');
  const [storeId, setStoreId] = useState(props.bases[0]?.storeId ?? '');
  const [viewId, setViewId] = useState('');
  const [events, setEvents] = useState<string[]>(['row.created']);
  const [filter, setFilter] = useState('');
  const [transition, setTransition] = useState(false);
  const [fields, setFields] = useState('');
  const [expand, setExpand] = useState<string[]>([]);
  const base = props.bases.find((b) => b.storeId === storeId);
  const toggle = (e: string) => setEvents(events.includes(e) ? events.filter((x) => x !== e) : [...events, e]);

  const create = async () => {
    try {
      const res = await api<{ webhook: { id: string }; secret: string }>('POST', '/webhooks', {
        name,
        url,
        storeId: events.some((e) => e !== 'gate.quota') ? storeId : '',
        viewId,
        events,
        filter,
        transition,
        fields,
        expand,
      });
      await props.onCreated(res.secret);
    } catch (err) {
      props.onError(err as Error);
    }
  };

  return (
    <section class="card" style={{ display: 'flex', flexDirection: 'column', gap: '14px', borderColor: '#a9c6ea' }} aria-labelledby="newhook">
      <h2 id="newhook">{t('Nouveau webhook')}</h2>
      <div class="grid2">
        <div class="field">
          <label for="hname">{t('Nom')}</label>
          <input id="hname" class="input" value={name} placeholder={t('Facturation : nouvelle commande')} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </div>
        <div class="field">
          <label for="hurl">{t('Adresse appelée')}</label>
          <input id="hurl" class="input mono" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value.trim())} />
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 20px' }}>
        {Object.entries(EVENT_TEXT).map(([e, label]) => (
          <label class="check">
            <input type="checkbox" checked={events.includes(e)} onChange={() => toggle(e)} /> {t(label)} <span class="mono muted">{e}</span>
          </label>
        ))}
      </div>
      <div class="grid2">
        <div class="field">
          <label for="hbase">{t('Base')}</label>
          <select id="hbase" class="input" value={storeId} onChange={(e) => {
            setStoreId((e.target as HTMLSelectElement).value);
            setViewId('');
            setExpand([]);
          }}>
            {props.bases.map((b) => (
              <option value={b.storeId}>{b.title}</option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="hview">{t('Vue (facultatif : seules ses lignes déclenchent)')}</label>
          <select id="hview" class="input" value={viewId} onChange={(e) => setViewId((e.target as HTMLSelectElement).value)}>
            <option value="">{t('toute la base')}</option>
            {(base?.views ?? []).map((v) => (
              <option value={v.id}>{v.name}</option>
            ))}
          </select>
        </div>
      </div>
      <div class="field">
        <label for="hfilter">{t('Condition (SQL, sur les champs JSON de la ligne)')}</label>
        <input id="hfilter" class="input mono" value={filter} placeholder="montant > 0" onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
      </div>
      <label class="check">
        <input type="checkbox" checked={transition} onChange={() => setTransition(!transition)} /> {t('Seulement quand la condition DEVIENT vraie (« statut devient Perdu »)')}
      </label>
      <div class="grid2">
        <div class="field">
          <label for="hfields">{t('Champs envoyés (vide : toute la ligne)')}</label>
          <input id="hfields" class="input mono" value={fields} placeholder="nom, ville, ca" onInput={(e) => setFields((e.target as HTMLInputElement).value)} />
        </div>
        <div class="field">
          <span style={{ fontWeight: 600, fontSize: '13px' }}>{t('Relations à résoudre')}</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
            {(base?.fields ?? [])
              .filter((f) => f.relation)
              .map((f) => (
                <label class="check">
                  <input type="checkbox" checked={expand.includes(f.name)} onChange={() => setExpand(expand.includes(f.name) ? expand.filter((x) => x !== f.name) : [...expand, f.name])} />{' '}
                  <span class="mono">{f.name}</span>
                </label>
              ))}
            {(base?.fields ?? []).every((f) => !f.relation) ? <span class="muted">—</span> : null}
          </div>
        </div>
      </div>
      <div class="row-actions">
        <button class="btn primary" type="button" disabled={name.trim() === '' || !/^https?:\/\/.+/.test(url) || events.length === 0} onClick={() => void create()}>
          {t('Créer le webhook')}
        </button>
      </div>
    </section>
  );
}
