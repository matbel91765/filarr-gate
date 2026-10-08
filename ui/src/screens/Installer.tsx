/** 1 · Premier lancement : le jeton, l'adresse d'écoute, la protection de l'interface. */

import { useState } from 'preact/hooks';
import { api } from '../api';
import { BrandMark, LangSwitch, tierLabel } from '../components';
import { fmtBytes, fmtNumber, plural, t } from '../i18n';

interface Steps {
  recognized: boolean;
  accessName: string | null;
  tier: string | null;
  bases: string[];
  blocks: number;
  bytes: number;
  rows: number;
  seconds: number;
  problems: Array<{ base: string; status: string; message: string | null }>;
}

export function Installer(props: { state: { setup: { hasToken: boolean; needsCode: boolean }; publicUrl?: string }; onDone: () => void }) {
  const [step, setStep] = useState(1);
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [steps, setSteps] = useState<Steps | null>(null);
  const [verified, setVerified] = useState(props.state.setup.hasToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('8443');
  const [https, setHttps] = useState(false);
  const [tlsCert, setTlsCert] = useState('');
  const [tlsKey, setTlsKey] = useState('');
  const [corsClosed, setCorsClosed] = useState(true);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [metrics, setMetrics] = useState(true);
  const [mcp, setMcp] = useState(false);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verify = () =>
    run(async () => {
      const res = await api<{ steps: Steps }>('POST', '/setup/token', { token, code });
      setSteps(res.steps);
      setVerified(true);
    });

  const labels = [t('Jeton'), t('Adresse'), t('Protection')];
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(1, n - s.length));

  return (
    <div>
      <div style={{ background: '#0d151f', color: '#e9eff6', padding: '20px 32px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px' }}>
        <BrandMark />
        <div class="grow">
          <div class="brand-name">Filarr Gate</div>
          <div class="brand-sub">{t('premier lancement')}</div>
        </div>
        <span class="mono" style={{ color: '#9db0c4' }}>
          {location.origin}
          {local ? ` · ${t('écoute locale seulement')}` : ''}
        </span>
        <LangSwitch />
      </div>

      <main style={{ maxWidth: '880px', margin: '0 auto', padding: '36px 20px 48px', display: 'flex', flexDirection: 'column', gap: '22px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '26px', letterSpacing: '-0.01em' }}>{t('Brancher cette boîte noire sur Filarr')}</h1>
          <p style={{ margin: '8px 0 0', color: '#526276', fontSize: '15px' }}>
            {t("Trois étapes. Le jeton reste sur cette machine : c'est lui qui ouvre les bases, et Filarr n'en garde qu'une empreinte.")}
          </p>
        </div>

        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {labels.map((label, i) => (
            <li class={`badge ${i + 1 < step ? 'ok' : i + 1 === step ? '' : 'grey'}`} style={{ padding: '6px 12px', fontSize: '13px' }} aria-current={i + 1 === step ? 'step' : undefined}>
              {i + 1} · {label}
            </li>
          ))}
        </ol>

        {props.state.setup.needsCode ? (
          <section class="card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div class="field">
              <label for="code">{t('Code de mise en route')}</label>
              <input id="code" class="input mono" inputMode="numeric" value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value.trim())} />
              <span class="muted" style={{ fontSize: '12.5px' }}>
                {t("Vous n'êtes pas sur la machine de la boîte noire : saisissez le code affiché dans sa console (ou `docker logs`).")}
              </span>
            </div>
          </section>
        ) : null}

        {error ? (
          <div class="notice bad" role="alert">
            {error}
          </div>
        ) : null}

        {step === 1 ? (
          <section class="card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }} aria-labelledby="s1">
            <h2 id="s1">{t("1 · Le jeton de l'accès")}</h2>
            <p class="hint">{t("Dans Filarr, sur la base : « ··· » › « Ouvrir à une API ». Le jeton s'affiche une seule fois ; collez-le ici.")}</p>
            {props.state.setup.hasToken && !steps ? (
              <div class="notice info">{t('Un jeton est déjà fourni à cette boîte noire (variable FILARR_GATE_TOKEN ou commande init).')}</div>
            ) : (
              <div class="field">
                <label for="tok">{t('Jeton')}</label>
                <input
                  id="tok"
                  class="input mono"
                  type="password"
                  autoComplete="off"
                  spellcheck={false}
                  placeholder="flr_live_…"
                  value={token}
                  onInput={(e) => {
                    setToken((e.target as HTMLInputElement).value.trim());
                    setVerified(false);
                    setSteps(null);
                  }}
                  aria-describedby="tokhint"
                />
                <span id="tokhint" style={{ color: '#526276', fontSize: '12.5px' }}>
                  {t("Il commence par flr_live_. Il n'est jamais envoyé à Filarr : la boîte noire en tire ses clés, et ne présente au serveur qu'une preuve.")}
                </span>
              </div>
            )}
            {steps ? (
              <div class="code" aria-label={t('Ce qui se passe')} aria-live="polite">
                <span class="c">{t('# ce que fait la boîte noire, sur cette machine')}</span>
                {'\n'}
                <span class="k">✓</span> {pad(t('jeton reconnu par Filarr'), 32)}
                {t('accès « {name} »', { name: steps.accessName ?? '—' })} · {tierLabel(steps.tier)}
                {'\n'}
                <span class="k">✓</span> {pad(t("clés de l'accès dérivées"), 32)}
                {t('sans aller-retour')}
                {'\n'}
                <span class="k">✓</span> {pad(plural(steps.bases.length, '{n} base ouverte', '{n} bases ouvertes'), 32)}
                {steps.bases.join(', ') || '—'}
                {'\n'}
                <span class="k">✓</span> {pad(plural(steps.blocks, '{n} bloc chiffré reçu', '{n} blocs chiffrés reçus'), 32)}
                {fmtBytes(steps.bytes)}
                {'\n'}
                <span class="k">✓</span> {pad(plural(steps.rows, '{n} ligne déchiffrée', '{n} lignes déchiffrées'), 32)}
                {t('en {s} s', { s: fmtNumber(steps.seconds, 1) })}
                {steps.problems.map((p) => (
                  <>
                    {'\n'}
                    <span style={{ color: '#f0a39b' }}>✗</span> {pad(p.base, 32)}
                    {p.message ?? p.status}
                  </>
                ))}
              </div>
            ) : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'flex-end' }}>
              {!verified ? (
                <button class="btn primary" type="button" disabled={busy || token.length < 70} onClick={() => void verify()}>
                  {busy ? t('Vérification…') : t('Vérifier le jeton')}
                </button>
              ) : (
                <button class="btn primary" type="button" onClick={() => setStep(2)}>
                  {t('Continuer')}
                </button>
              )}
            </div>
          </section>
        ) : null}

        {step === 2 ? (
          <section class="card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }} aria-labelledby="s2">
            <h2 id="s2">{t('2 · Où vos logiciels la trouvent')}</h2>
            <p class="hint">{t("L'API et cette interface écoutent ici. Par défaut, seulement cette machine.")}</p>
            <div class="grid2">
              <div class="field">
                <label for="host">{t("Adresse d'écoute")}</label>
                <input id="host" class="input mono" value={host} onInput={(e) => setHost((e.target as HTMLInputElement).value.trim())} />
              </div>
              <div class="field">
                <label for="port">{t('Port')}</label>
                <input id="port" class="input mono" inputMode="numeric" value={port} onInput={(e) => setPort((e.target as HTMLInputElement).value.trim())} />
              </div>
            </div>
            <label class="check">
              <input type="checkbox" checked={https} onChange={(e) => setHttps((e.target as HTMLInputElement).checked)} /> {t('Chiffrer la connexion (HTTPS, avec un certificat fourni)')}
            </label>
            {https ? (
              <div class="grid2">
                <div class="field">
                  <label for="cert">{t('Certificat (chemin PEM)')}</label>
                  <input id="cert" class="input mono" value={tlsCert} onInput={(e) => setTlsCert((e.target as HTMLInputElement).value.trim())} placeholder="/etc/gate/cert.pem" />
                </div>
                <div class="field">
                  <label for="key">{t('Clé privée (chemin PEM)')}</label>
                  <input id="key" class="input mono" value={tlsKey} onInput={(e) => setTlsKey((e.target as HTMLInputElement).value.trim())} placeholder="/etc/gate/key.pem" />
                </div>
              </div>
            ) : null}
            <label class="check">
              <input type="checkbox" checked={corsClosed} onChange={(e) => setCorsClosed((e.target as HTMLInputElement).checked)} /> {t("Refuser les requêtes d'une page web (CORS fermé)")}
            </label>
            {host === '0.0.0.0' && !https ? <div class="notice warn">{t("L'API sera joignable depuis le réseau sans chiffrement : mettez-la derrière un mandataire HTTPS, ou fournissez un certificat.")}</div> : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'space-between' }}>
              <button class="btn" type="button" onClick={() => setStep(1)}>
                {t('Retour')}
              </button>
              <button
                class="btn primary"
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api('POST', '/setup/network', { host, port: Number(port), https, ...(https ? { tlsCert, tlsKey } : {}), corsClosed, code });
                    setStep(3);
                  })
                }
              >
                {t('Continuer')}
              </button>
            </div>
          </section>
        ) : null}

        {step === 3 ? (
          <section class="card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }} aria-labelledby="s3">
            <h2 id="s3">{t('3 · Protéger cette interface')}</h2>
            <p class="hint">{t("Qui gère la boîte noire voit les données en clair. Une clé d'accès (passkey) ou un mot de passe la protège.")}</p>
            <div class="grid2">
              <button class="btn" type="button" disabled title={t('Pas encore disponible dans cette version')}>
                {t("Créer une clé d'accès")}
              </button>
              <button class="btn primary" type="button" aria-pressed="true">
                {t('Utiliser un mot de passe')}
              </button>
            </div>
            <div class="grid2">
              <div class="field">
                <label for="pw1">{t('Mot de passe (dix caractères au moins)')}</label>
                <input id="pw1" class="input" type="password" autoComplete="new-password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
              </div>
              <div class="field">
                <label for="pw2">{t('Encore une fois')}</label>
                <input id="pw2" class="input" type="password" autoComplete="new-password" value={confirm} onInput={(e) => setConfirm((e.target as HTMLInputElement).value)} />
              </div>
            </div>
            <div class="sep" />
            <label class="check">
              <input type="checkbox" checked={metrics} onChange={(e) => setMetrics((e.target as HTMLInputElement).checked)} /> {t('Envoyer les métriques au format Prometheus sur /metrics')}
            </label>
            <label class="check">
              <input type="checkbox" checked={mcp} onChange={(e) => setMcp((e.target as HTMLInputElement).checked)} /> {t('Activer le serveur MCP (assistants IA, lecture seule)')}
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'space-between' }}>
              <button class="btn" type="button" onClick={() => setStep(2)}>
                {t('Retour')}
              </button>
              <button
                class="btn primary"
                type="button"
                disabled={busy || password.length < 10 || password !== confirm}
                onClick={() =>
                  void run(async () => {
                    await api('POST', '/setup/finish', { password, metrics, mcp, code });
                    location.hash = '#/';
                    props.onDone();
                  })
                }
              >
                {t('Ouvrir le tableau de bord')}
              </button>
            </div>
          </section>
        ) : null}

        <p style={{ margin: 0, color: '#526276', fontSize: '13px' }}>
          {t('Sans interface :')} <span class="mono">filarr-gate init --token flr_live_… --port 8443</span>
          {t(', ou la variable')} <span class="mono">FILARR_GATE_TOKEN</span> {t('dans Docker.')}
        </p>
      </main>
    </div>
  );
}
