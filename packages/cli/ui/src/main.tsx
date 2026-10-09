import { render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import './gate.css';
import { api, whenUnauthorized } from './api';
import { BrandMark, LangSwitch, Shell, type Route, type ShellSummary } from './components';
import { lang, t } from './i18n';
import { Bases } from './screens/Bases';
import { Dashboard } from './screens/Dashboard';
import { Explorer } from './screens/Explorer';
import { Installer } from './screens/Installer';
import { Journal } from './screens/Journal';
import { Keys } from './screens/Keys';
import { Limits } from './screens/Limits';
import { Settings } from './screens/Settings';
import { Webhooks } from './screens/Webhooks';

interface StateResponse extends ShellSummary {
  authenticated: boolean;
  setup: { done: boolean; hasToken: boolean; needsCode: boolean };
}

function routeOf(hash: string): Route {
  const r = hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  const known: Route[] = ['bases', 'sql', 'keys', 'webhooks', 'journal', 'limits', 'settings'];
  return (known as string[]).includes(r ?? '') ? (r as Route) : 'dashboard';
}

function Login(props: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/login', { password });
      props.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="login">
      <form class="card" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }} onSubmit={submit}>
        <div class="brand" style={{ padding: 0, color: 'var(--ink)' }}>
          <BrandMark />
          <div>
            <div class="brand-name">Filarr Gate</div>
            <div class="muted" style={{ fontSize: '12.5px' }}>
              {t('Interface de gestion')}
            </div>
          </div>
          <span class="grow" />
          <span style={{ background: 'var(--box)', padding: '4px 6px', borderRadius: '8px' }}>
            <LangSwitch />
          </span>
        </div>
        <p class="hint">{t('Qui gère la boîte noire voit les données en clair. Entrez le mot de passe posé à la mise en route.')}</p>
        <div class="field">
          <label for="pw">{t('Mot de passe')}</label>
          <input id="pw" class="input" type="password" autoComplete="current-password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} autoFocus />
        </div>
        {error ? (
          <div class="notice bad" role="alert">
            {error}
          </div>
        ) : null}
        <button class="btn primary" type="submit" disabled={busy || password === ''}>
          {t('Se connecter')}
        </button>
      </form>
    </div>
  );
}

function App() {
  const [state, setState] = useState<StateResponse | null>(null);
  const [route, setRoute] = useState<Route>(routeOf(location.hash));
  const [failure, setFailure] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api<StateResponse>('GET', '/state'));
      setFailure(null);
    } catch (err) {
      setFailure((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    whenUnauthorized(() => void refresh());
    const onHash = () => setRoute(routeOf(location.hash));
    window.addEventListener('hashchange', onHash);
    const timer = setInterval(() => void refresh(), 10_000);
    return () => {
      window.removeEventListener('hashchange', onHash);
      clearInterval(timer);
    };
  }, [refresh]);

  // Relire la langue suffit à redessiner : le signal est lu ici
  void lang.value;

  if (!state) {
    return <div class="empty">{failure ? t('La boîte noire ne répond pas : {error}', { error: failure }) : t('Chargement…')}</div>;
  }
  if (!state.setup.done) return <Installer state={state} onDone={() => void refresh()} />;
  if (!state.authenticated) return <Login onDone={() => void refresh()} />;

  const logout = async () => {
    await api('POST', '/logout').catch(() => undefined);
    await refresh();
  };
  const screens: Record<Route, preact.JSX.Element> = {
    dashboard: <Dashboard />,
    bases: <Bases />,
    sql: <Explorer />,
    keys: <Keys onChange={refresh} />,
    webhooks: <Webhooks onChange={refresh} />,
    journal: <Journal />,
    limits: <Limits />,
    settings: <Settings onChange={refresh} />,
  };
  return (
    <Shell route={route} summary={state} onLogout={() => void logout()}>
      {screens[route]}
    </Shell>
  );
}

document.documentElement.lang = lang.value;
render(<App />, document.getElementById('app')!);
