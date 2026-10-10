/**
 * Le diagnostic d'une boîte noire (`filarr-gate doctor`, `GET /admin/api/doctor`) :
 * ce qui l'empêche de servir, dit en une ligne par point, sans rien changer.
 *  - Filarr joignable, et l'horloge de cette machine (les réveils poussés refusent
 *    5 minutes d'écart, les registres datent les écritures) ;
 *  - le jeton et sa liaison, la clé du créateur (étiquette et `bind_sig`) ;
 *  - chaque base : clés présentes, scellés vérifiés ;
 *  - les quotas du mois, la boîte de dépôt signée, les synchros bloquées ;
 *  - l'écriture allumée ici mais fermée par Filarr.
 */

import type { GateCore } from './core';

export interface DoctorCheck {
  name: string;
  result: 'ok' | 'warn' | 'fail';
  detail: string;
}

export async function runDoctor(core: GateCore, fetchImpl: typeof fetch = fetch): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, result: DoctorCheck['result'], detail: string) => checks.push({ name, result, detail });
  const apiUrl = core.settings.apiUrl;
  try {
    const started = Date.now();
    const res = await fetchImpl(new URL('public/api-limits', apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`), { signal: AbortSignal.timeout(10_000) });
    await res.arrayBuffer().catch(() => undefined);
    add('filarr', res.ok ? 'ok' : 'warn', `${apiUrl} répond ${res.status} en ${Date.now() - started} ms`);
    const date = res.headers.get('date');
    if (date) {
      const skew = Math.round((Date.parse(date) - Date.now()) / 1000);
      add('horloge', Math.abs(skew) > 240 ? 'fail' : Math.abs(skew) > 30 ? 'warn' : 'ok', `écart avec Filarr : ${skew} s${Math.abs(skew) > 240 ? ' (les réveils sont refusés au-delà de 300 s)' : ''}`);
    }
  } catch (err) {
    add('filarr', 'fail', `${apiUrl} injoignable : ${(err as Error).message}`);
  }

  const r = core.replicator;
  if (!r.identity) {
    add('jeton', 'fail', 'aucun jeton : filarr-gate init --token flr_live_…');
    return checks;
  }
  const linkOk = ['live', 'polling', 'connecting'].includes(r.link);
  const linkDead = ['revoked', 'expired', 'unknown_access', 'no_token'].includes(r.link);
  add('jeton', linkOk ? 'ok' : linkDead ? 'fail' : 'warn', `liaison : ${r.link}${r.linkDetail ? ` (${r.linkDetail})` : ''} · ${r.identity.hint}`);
  add('créateur', r.creator.status === 'authenticated' ? 'ok' : r.creator.status === 'refused' ? 'fail' : 'warn', `clé du créateur : ${r.creator.status}${r.creator.reason ? ` (${r.creator.reason})` : ''}`);
  for (const b of r.bases.values()) {
    const st = b.mirror.status;
    add(`base ${b.manifest?.slug ?? b.storeId}`, st === 'ready' ? 'ok' : st === 'missing_key' || st === 'unverified' ? 'fail' : 'warn', `${st}${b.mirror.problem ? ` : ${b.mirror.problem.message}` : ''} · ${b.mirror.rows.length} lignes`);
  }
  if (r.refused.length > 0) add('scellés', 'fail', `${r.refused.length} scellé(s) refusé(s) : ${r.refused.map((x) => `${x.what} ${x.storeId} (${x.reason})`).join(' ; ')}`);
  const q = r.client?.quota;
  for (const name of ['sync', 'bytes', 'writes'] as const) {
    const c = q?.[name];
    if (c && c.max > 0) {
      const pct = Math.round((c.used / c.max) * 100);
      add(`quota ${name}`, pct >= 100 ? 'fail' : pct >= 80 ? 'warn' : 'ok', `${c.used} / ${c.max} (${pct} %)`);
    }
  }
  if (r.files) add('fichiers', r.files.signed ? 'ok' : 'fail', r.files.signed ? `boîte de dépôt liée et signée · ${r.files.pending.n} en attente de rangement` : 'boîte de dépôt NON signée par le créateur : les dépôts sont refusés');
  for (const s of core.sync?.list() ?? []) {
    add(`synchro ${s.def.name}`, s.blocked ? (s.blocked === 'paused' ? 'warn' : 'fail') : 'ok', s.blocked ? `${s.blocked}${s.detail ? ` : ${s.detail}` : ''}` : `prête · ${s.def.connector} · ${s.def.host}`);
  }
  if (core.settings.write && r.access?.write === false) add('écriture', 'warn', 'l’écriture est allumée ici mais Filarr ne l’ouvre pas à cet accès');
  return checks;
}
