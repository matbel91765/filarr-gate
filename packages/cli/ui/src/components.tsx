/** Le cadre commun des écrans (navigation de la maquette) et les petits éléments partagés. */

import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiFailure } from './api';
import { lang, setLang, t } from './i18n';

export type Route = 'dashboard' | 'bases' | 'sql' | 'keys' | 'webhooks' | 'journal' | 'limits' | 'settings';

export const ROUTES: Record<Route, string> = {
  dashboard: '#/',
  bases: '#/bases',
  sql: '#/sql',
  keys: '#/keys',
  webhooks: '#/webhooks',
  journal: '#/journal',
  limits: '#/limits',
  settings: '#/settings',
};

const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

const ICONS: Record<Route, ComponentChildren> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  bases: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  sql: (
    <>
      <path d="M4 6h16M4 12h10M4 18h7" />
      <path d="M17 15l3 3-3 3" />
    </>
  ),
  keys: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M17 6l3 3" />
    </>
  ),
  webhooks: (
    <>
      <path d="M10 14a4 4 0 1 1 4-4" />
      <path d="M14 10l6 6" />
      <circle cx="18" cy="18" r="3" />
    </>
  ),
  journal: (
    <>
      <path d="M5 4h11l3 3v13H5z" />
      <path d="M9 10h6M9 14h6M9 18h4" />
    </>
  ),
  limits: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </>
  ),
};

export function BrandMark() {
  return (
    <div class="brand-mark">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e9eff6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <path d="M9 12h6" />
      </svg>
    </div>
  );
}

export function LangSwitch() {
  return (
    <span class="lang" role="group" aria-label={t('Langue')}>
      {(['fr', 'en'] as const).map((l) => (
        <button type="button" class={lang.value === l ? 'on' : ''} aria-pressed={lang.value === l} onClick={() => setLang(l)}>
          {l.toUpperCase()}
        </button>
      ))}
    </span>
  );
}

export interface ShellSummary {
  version: string;
  link?: { state: string; detail: string | null };
  access?: { name: string | null; tier: string | null } | null;
  counts?: { bases: number; keys: number; webhooks: number };
}

/** L'état de la liaison avec Filarr, en mots et en couleur. */
export function linkLabel(state: string | undefined): { text: string; cls: string } {
  switch (state) {
    case 'live':
      return { text: t('En direct'), cls: 'ok' };
    case 'polling':
      return { text: t('Relève périodique'), cls: 'ok' };
    case 'connecting':
      return { text: t('Connexion…'), cls: 'grey' };
    case 'offline':
      return { text: t('Filarr injoignable'), cls: 'warn' };
    case 'limited':
      return { text: t('Limité par Filarr'), cls: 'warn' };
    case 'paused':
      return { text: t('Accès en pause'), cls: 'warn' };
    case 'not_switched':
      return { text: t('Accès API pas encore ouverts'), cls: 'warn' };
    case 'ip_forbidden':
      return { text: t('Adresse refusée par Filarr'), cls: 'bad' };
    case 'revoked':
      return { text: t('Accès révoqué'), cls: 'bad' };
    case 'expired':
      return { text: t('Accès expiré'), cls: 'bad' };
    case 'unknown_access':
      return { text: t('Jeton inconnu de Filarr'), cls: 'bad' };
    case 'upgrade_required':
      return { text: t('Mise à jour requise'), cls: 'bad' };
    case 'no_token':
      return { text: t('Sans jeton'), cls: 'grey' };
    default:
      return { text: t('Erreur'), cls: 'bad' };
  }
}

export function tierLabel(tier: string | null | undefined): string {
  if (!tier) return '—';
  return t('palier {tier}', { tier: tier.charAt(0).toUpperCase() + tier.slice(1) });
}

export function Shell(props: { route: Route; summary: ShellSummary | null; onLogout: () => void; children: ComponentChildren }) {
  const s = props.summary;
  const link = linkLabel(s?.link?.state);
  const nav = (route: Route, label: string, count?: number) => (
    <a class={`nav ${props.route === route ? 'on' : ''}`} href={ROUTES[route]} aria-current={props.route === route ? 'page' : undefined}>
      <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        {ICONS[route]}
      </svg>
      {label}
      {count !== undefined ? <span class="nav-count">{count}</span> : null}
    </a>
  );
  return (
    <div class="shell">
      <nav class="side" aria-label={t('Navigation de Filarr Gate')}>
        <div class="brand">
          <BrandMark />
          <div>
            <div class="brand-name">Filarr Gate</div>
            <div class="brand-sub">{t('la boîte noire · v{version}', { version: s?.version ?? '' })}</div>
          </div>
        </div>
        {nav('dashboard', t('Tableau de bord'))}
        {nav('bases', t("Bases et points d'accès"), s?.counts?.bases)}
        {nav('sql', t('Explorateur SQL'))}
        {nav('keys', t('Clés des applications'), s?.counts?.keys)}
        {nav('webhooks', t('Webhooks'), s?.counts?.webhooks)}
        {nav('journal', t('Journal'))}
        <div class="nav-label">{t('Compte Filarr')}</div>
        {nav('limits', t('Consommation et limites'))}
        {nav('settings', t('Réglages'))}
        <div class="side-foot">
          <span>
            <span class="dot" style={{ color: link.cls === 'ok' ? '#4fc98a' : link.cls === 'warn' ? '#e0a23a' : link.cls === 'bad' ? '#f07167' : '#9db0c4' }} />{' '}
            {s?.link?.state === 'live' || s?.link?.state === 'polling' ? t('Synchronisé avec Filarr') : link.text}
          </span>
          {s?.access ? (
            <span class="mono">
              {t('accès « {name} »', { name: s.access.name ?? '—' })} · {tierLabel(s.access.tier)}
            </span>
          ) : null}
          <span style={{ display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'space-between' }}>
            <LangSwitch />
            <button type="button" class="lang-out" onClick={props.onLogout} style={{ border: 0, background: 'none', color: '#9db0c4', font: 'inherit', fontSize: '12px', cursor: 'pointer', textDecoration: 'underline' }}>
              {t('Se déconnecter')}
            </button>
          </span>
        </div>
      </nav>
      <main class="main">{props.children}</main>
    </div>
  );
}

export function Badge(props: { cls?: string; dot?: boolean; children: ComponentChildren }) {
  return (
    <span class={`badge ${props.cls ?? ''}`}>
      {props.dot ? <span class="dot" /> : null}
      {props.children}
    </span>
  );
}

export function Meter(props: { pct: number; warn?: boolean; label?: string }) {
  const pct = Math.max(0, Math.min(100, props.pct));
  return (
    <div class={`meter ${props.warn || pct >= 80 ? 'warn' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={props.label}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function rightsLabel(rights: string): { text: string; cls: string } {
  return rights === 'rw' ? { text: t('lecture et écriture'), cls: '' } : { text: t('lecture seule'), cls: 'grey' };
}

/** L'état d'une base répliquée. */
export function baseStatus(status: string): { text: string; cls: string } {
  switch (status) {
    case 'ready':
      return { text: t('à jour'), cls: 'ok' };
    case 'loading':
      return { text: t('chargement…'), cls: 'grey' };
    case 'missing_key':
      return { text: t('clé manquante'), cls: 'bad' };
    case 'unverified':
      return { text: t('non vérifiée'), cls: 'bad' };
    case 'waiting':
      return { text: t('en attente (limite)'), cls: 'warn' };
    case 'refused':
      return { text: t('refusée par Filarr'), cls: 'bad' };
    case 'offline':
      return { text: t('hors ligne'), cls: 'warn' };
    default:
      return { text: status, cls: 'grey' };
  }
}

/** Charge (et recharge à intervalle) une ressource de l'API d'administration. */
export function useResource<T>(path: string | null, intervalMs = 0): { data: T | null; error: ApiFailure | null; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const out = await api<T>('GET', path);
      if (alive.current) {
        setData(out);
        setError(null);
      }
    } catch (err) {
      if (alive.current) setError(err as ApiFailure);
    }
  }, [path]);
  useEffect(() => {
    alive.current = true;
    void reload();
    if (!intervalMs) return () => {
      alive.current = false;
    };
    const timer = setInterval(() => void reload(), intervalMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [reload, intervalMs]);
  return { data, error, reload };
}

export function ErrorNotice(props: { error: Error | null }) {
  if (!props.error) return null;
  return (
    <div class="notice bad" role="alert">
      {props.error.message}
    </div>
  );
}

/** Copie un texte, avec un mot de confirmation. */
export function CopyButton(props: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      class="btn small"
      onClick={() => {
        void navigator.clipboard?.writeText(props.text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? t('Copié') : (props.label ?? t('Copier'))}
    </button>
  );
}
