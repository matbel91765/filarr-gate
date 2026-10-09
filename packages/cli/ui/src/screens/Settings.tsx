/** 9 · Réglages. */

import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';
import { ErrorNotice, linkLabel, useResource } from '../components';
import { fmtBytes, fmtDate, fmtNumber, t } from '../i18n';

interface Settings {
  apiUrl: string;
  host: string;
  port: number;
  adminHost: string;
  adminPort: number;
  write: boolean;
  tlsCert: string | null;
  tlsKey: string | null;
  corsOrigins: string[];
  trustProxy: string[];
  metrics: boolean;
  mcp: boolean;
  docs: boolean;
  journalDays: number;
  cache: 'disk' | 'memory';
  pollSeconds: number;
}

interface SettingsData {
  settings: Settings;
  sources: Record<keyof Settings, 'env' | 'file' | 'settings' | 'default'>;
  envNames: Record<keyof Settings, string>;
  stateDir: string;
  configFile: string | null;
  token: { hint: string; fingerprint: string; source: string | null } | null;
  access: { name: string | null; expiresAt: string | null } | null;
  link: { state: string; detail: string | null; streamRefused: boolean; pollSeconds: number };
  cache: { kind: string; location: string | null; bytes: number };
  rows: number;
  passwordFromEnv: boolean;
  version: string;
}

export function Settings(props: { onChange: () => void }) {
  const { data, error, reload } = useResource<SettingsData>('/settings');
  const [draft, setDraft] = useState<Partial<Settings>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);
  const [token, setToken] = useState('');
  const [pw, setPw] = useState({ current: '', next: '' });
  const [forget, setForget] = useState('');
  useEffect(() => setDraft({}), [data]);
  if (!data) return <ErrorNotice error={error} />;

  const s = { ...data.settings, ...draft };
  const locked = (k: keyof Settings) => data.sources[k] === 'env' || data.sources[k] === 'file';
  const lockNote = (k: keyof Settings) =>
    locked(k) ? (
      <span class="muted" style={{ fontSize: '12px' }}>
        {data.sources[k] === 'env' ? t('fixé par {name}', { name: data.envNames[k] }) : t('fixé par gate.toml')}
      </span>
    ) : null;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft({ ...draft, [k]: v });
  const certMode = s.tlsCert && s.tlsKey ? 'provided' : 'none';

  const run = async (task: () => Promise<unknown>, done?: string) => {
    setFailure(null);
    setNotice(null);
    try {
      await task();
      if (done) setNotice(done);
      await reload();
      props.onChange();
    } catch (err) {
      setFailure(err as Error);
    }
  };

  const save = () =>
    run(async () => {
      const res = await api<{ restarted: boolean }>('PUT', '/settings', draft);
      setNotice(res.restarted ? t('Enregistré. L’API locale écoute maintenant à sa nouvelle adresse.') : t('Enregistré.'));
    });

  const link = linkLabel(data.link.state);

  return (
    <>
      <div class="top">
        <div class="grow">
          <h1>{t('Réglages')}</h1>
          <div class="sub">
            {t('Tout se règle aussi par fichier')} (<span class="mono">gate.toml</span>) {t("ou par variables d'environnement, pour Docker et les déploiements scriptés.")}
          </div>
        </div>
        <button class="btn primary" type="button" disabled={Object.keys(draft).length === 0} onClick={() => void save()}>
          {t('Enregistrer')}
        </button>
      </div>
      <ErrorNotice error={error ?? failure} />
      {notice ? <div class="notice ok">{notice}</div> : null}

      <div class="grid2" style={{ alignItems: 'start' }}>
        <section class="card" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }} aria-labelledby="net">
          <h2 id="net">{t('Réseau')}</h2>
          <div class="grid2">
            <div class="field">
              <label for="h">{t("Adresse d'écoute")}</label>
              <input id="h" class="input mono" disabled={locked('host')} value={s.host} onInput={(e) => set('host', (e.target as HTMLInputElement).value.trim())} />
              {lockNote('host')}
            </div>
            <div class="field">
              <label for="p">{t('Port')}</label>
              <input id="p" class="input mono" inputMode="numeric" disabled={locked('port')} value={String(s.port)} onInput={(e) => set('port', Number((e.target as HTMLInputElement).value))} />
              {lockNote('port')}
            </div>
          </div>
          <div class="field">
            <label for="cert">{t('Certificat HTTPS')}</label>
            <select
              id="cert"
              class="input"
              disabled={locked('tlsCert')}
              value={certMode}
              onChange={(e) => {
                if ((e.target as HTMLSelectElement).value === 'none') setDraft({ ...draft, tlsCert: null, tlsKey: null });
                else setDraft({ ...draft, tlsCert: s.tlsCert ?? '', tlsKey: s.tlsKey ?? '' });
              }}
            >
              <option value="provided">{s.tlsCert ? t('Fourni : {path}', { path: s.tlsCert }) : t('Fourni (chemins ci-dessous)')}</option>
              <option value="none">{t('Aucun (derrière un proxy)')}</option>
            </select>
            {lockNote('tlsCert')}
          </div>
          {draft.tlsCert !== undefined && draft.tlsCert !== null ? (
            <div class="grid2">
              <div class="field">
                <label for="tc">{t('Certificat (PEM)')}</label>
                <input id="tc" class="input mono" value={s.tlsCert ?? ''} onInput={(e) => set('tlsCert', (e.target as HTMLInputElement).value.trim())} />
              </div>
              <div class="field">
                <label for="tk">{t('Clé privée (PEM)')}</label>
                <input id="tk" class="input mono" value={s.tlsKey ?? ''} onInput={(e) => set('tlsKey', (e.target as HTMLInputElement).value.trim())} />
              </div>
            </div>
          ) : null}
          <div class="field">
            <label for="cors">{t('Pages web autorisées (CORS)')}</label>
            <input
              id="cors"
              class="input mono"
              disabled={locked('corsOrigins')}
              placeholder={t('aucune (CORS fermé)')}
              value={s.corsOrigins.join(', ')}
              onInput={(e) => set('corsOrigins', (e.target as HTMLInputElement).value.split(',').map((x) => x.trim()).filter(Boolean))}
            />
            {lockNote('corsOrigins')}
          </div>
          <div class="field">
            <label for="proxy">{t('Faire confiance à X-Forwarded-For de')}</label>
            <input
              id="proxy"
              class="input mono"
              disabled={locked('trustProxy')}
              placeholder={t('personne')}
              value={s.trustProxy.join(', ')}
              onInput={(e) => set('trustProxy', (e.target as HTMLInputElement).value.split(',').map((x) => x.trim()).filter(Boolean))}
            />
            {lockNote('trustProxy')}
          </div>
          <p class="hint">
            {t('Interface de gestion :')} <span class="mono">{`${s.adminHost}:${s.adminPort}`}</span> {t('(FILARR_GATE_ADMIN_HOST, FILARR_GATE_ADMIN_PORT)')}
          </p>
        </section>

        <section class="card" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }} aria-labelledby="link">
          <h2 id="link">{t('Liaison avec Filarr')}</h2>
          <dl class="kv">
            <dt>{t('Accès')}</dt>
            <dd>{data.access?.name ?? '—'}</dd>
            <dt>{t('Empreinte du jeton')}</dt>
            <dd class="mono">{data.token ? `${data.token.hint} · sha256 ${data.token.fingerprint}` : '—'}</dd>
            <dt>{t('Expire')}</dt>
            <dd>{data.access ? (data.access.expiresAt ? fmtDate(data.access.expiresAt) : t('jamais')) : '—'}</dd>
            <dt>{t('Changements')}</dt>
            <dd>
              {data.link.state === 'live'
                ? t('en direct (connexion permanente)')
                : data.link.streamRefused
                  ? t('relève toutes les {n} s', { n: data.link.pollSeconds })
                  : link.text}
            </dd>
            <dt>{t('API Filarr')}</dt>
            <dd class="mono">{s.apiUrl}</dd>
          </dl>
          <label class="check">
            <input type="checkbox" disabled={locked('write')} checked={s.write} onChange={(e) => set('write', (e.target as HTMLInputElement).checked)} />{' '}
            {t('Écrire vers Filarr (droit « lecture et écriture » de l’accès requis)')}
          </label>
          {lockNote('write')}
          {data.token?.source === 'env' ? (
            <p class="hint">{t('Le jeton vient de FILARR_GATE_TOKEN : changez la variable pour le remplacer.')}</p>
          ) : (
            <div class="field">
              <label for="newtok">{t('Remplacer le jeton')}</label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input id="newtok" class="input mono" type="password" autoComplete="off" placeholder="flr_live_…" value={token} onInput={(e) => setToken((e.target as HTMLInputElement).value.trim())} />
                <button class="btn" type="button" disabled={token.length < 70} onClick={() => void run(() => api('POST', '/token', { token }).then(() => setToken('')), t('Nouveau jeton en service.'))}>
                  {t('Remplacer')}
                </button>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
            <button class="btn" type="button" onClick={() => void run(() => api('POST', '/resync'), t('Resynchronisation faite.'))}>
              {t('Resynchroniser tout')}
            </button>
          </div>
        </section>

        <section class="card" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }} aria-labelledby="admin">
          <h2 id="admin">{t('Accès à cette interface')}</h2>
          <p class="hint">{t("Qui entre ici lit les données en clair. Les clés d'accès résistent à l'hameçonnage.")}</p>
          <div class="notice info">{t("Les clés d'accès (passkeys) ne sont pas encore prises en charge : cette interface est protégée par mot de passe.")}</div>
          {data.passwordFromEnv ? (
            <p class="hint">{t('Le mot de passe vient de FILARR_GATE_ADMIN_PASSWORD.')}</p>
          ) : (
            <>
              <div class="grid2">
                <div class="field">
                  <label for="pwc">{t('Mot de passe actuel')}</label>
                  <input id="pwc" class="input" type="password" autoComplete="current-password" value={pw.current} onInput={(e) => setPw({ ...pw, current: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="field">
                  <label for="pwn">{t('Nouveau mot de passe')}</label>
                  <input id="pwn" class="input" type="password" autoComplete="new-password" value={pw.next} onInput={(e) => setPw({ ...pw, next: (e.target as HTMLInputElement).value })} />
                </div>
              </div>
              <button
                class="btn"
                type="button"
                style={{ alignSelf: 'flex-start' }}
                disabled={pw.next.length < 10 || pw.current === ''}
                onClick={() => void run(() => api('POST', '/password', pw).then(() => setPw({ current: '', next: '' })), t('Mot de passe changé.'))}
              >
                {t('Changer le mot de passe')}
              </button>
            </>
          )}
        </section>

        <section class="card" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }} aria-labelledby="store">
          <h2 id="store">{t('Copie locale')}</h2>
          <dl class="kv">
            <dt>{t('Emplacement')}</dt>
            <dd class="mono">{data.stateDir}</dd>
            <dt>{t('Format')}</dt>
            <dd>{data.cache.kind === 'disk' ? t('blocs chiffrés sur disque, lignes déchiffrées en mémoire seulement') : t('tout en mémoire (rien sur le disque)')}</dd>
            <dt>{t('Taille')}</dt>
            <dd>
              {fmtBytes(data.cache.bytes)} · {t('{n} lignes', { n: fmtNumber(data.rows) })}
            </dd>
          </dl>
          <label class="check">
            <input type="checkbox" disabled={locked('cache')} checked={s.cache === 'memory'} onChange={(e) => set('cache', (e.target as HTMLInputElement).checked ? 'memory' : 'disk')} />{' '}
            {t('Ne rien garder sur le disque, même chiffré (plus lent au redémarrage ; pris en compte au prochain démarrage)')}
          </label>
          {lockNote('cache')}
          <div class="field">
            <label for="ret">{t('Journal gardé')}</label>
            <select id="ret" class="input" disabled={locked('journalDays')} value={String(s.journalDays)} onChange={(e) => set('journalDays', Number((e.target as HTMLSelectElement).value))}>
              {[7, 30, 90].includes(s.journalDays) ? null : <option value={String(s.journalDays)}>{t('{n} jours', { n: s.journalDays })}</option>}
              <option value="30">{t('30 jours')}</option>
              <option value="7">{t('7 jours')}</option>
              <option value="90">{t('90 jours')}</option>
            </select>
            {lockNote('journalDays')}
          </div>
        </section>

        <section class="card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }} aria-labelledby="integ">
          <h2 id="integ">{t('Intégrations')}</h2>
          <label class="check">
            <input type="checkbox" disabled={locked('metrics')} checked={s.metrics} onChange={(e) => set('metrics', (e.target as HTMLInputElement).checked)} /> {t('Métriques Prometheus sur')}{' '}
            <span class="mono">/metrics</span>
          </label>
          <label class="check">
            <input type="checkbox" disabled /> {t('Traces OpenTelemetry (pas encore disponible)')}
          </label>
          <label class="check">
            <input type="checkbox" disabled={locked('mcp')} checked={s.mcp} onChange={(e) => set('mcp', (e.target as HTMLInputElement).checked)} /> {t('Serveur MCP pour les assistants IA (lecture seule, par clé)')}
          </label>
          <label class="check">
            <input type="checkbox" disabled={locked('docs')} checked={s.docs} onChange={(e) => set('docs', (e.target as HTMLInputElement).checked)} /> {t('Documentation OpenAPI publique sur')}{' '}
            <span class="mono">/docs</span>
          </label>
        </section>

        <section class="card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }} aria-labelledby="upd">
          <h2 id="upd">{t('Mises à jour')}</h2>
          <dl class="kv">
            <dt>{t('Version')}</dt>
            <dd>{data.version}</dd>
            <dt>{t('Mise à jour')}</dt>
            <dd>
              <span class="mono">npx filarr-gate@latest</span> {t('ou une image Docker plus récente')}
            </dd>
            <dt>{t('Fichier de réglages')}</dt>
            <dd class="mono">{data.configFile ?? '—'}</dd>
          </dl>
        </section>
      </div>

      <section class="card danger-card" style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' }} aria-labelledby="forget">
        <div class="grow" style={{ minWidth: '260px' }}>
          <h2 id="forget">{t('Oublier cette machine')}</h2>
          <p class="hint">{t("Efface la copie, les clés dérivées, le jeton, les clés des applications, les webhooks et le journal. Les données restent dans Filarr ; pour couper l'accès partout, révoquez-le dans Filarr.")}</p>
        </div>
        <input class="input" style={{ maxWidth: '200px' }} aria-label={t('Tapez « oublier » pour confirmer')} placeholder={t('tapez « oublier »')} value={forget} onInput={(e) => setForget((e.target as HTMLInputElement).value)} />
        <button class="btn danger" type="button" disabled={forget !== 'oublier'} onClick={() => void run(() => api('POST', '/forget', { confirm: 'oublier' }).then(() => (location.hash = '#/')))}>
          {t('Tout effacer ici')}
        </button>
      </section>
    </>
  );
}
