/** 8 · Consommation et limites : ce que compte Filarr, et le barème qu'il publie (`/public/api-limits`). */

import { ErrorNotice, Meter, tierLabel, useResource } from '../components';
import { fmtBytes, fmtDate, fmtNumber, fmtTime, t } from '../i18n';

interface ApiLimits {
  accesses: number;
  storesPerAccess: number;
  write: boolean;
  writesPerDay: number;
  syncPerMonth: number;
  bytesPerMonth: number;
  ratePerMinute: number;
  stream: boolean;
  pollIntervalS: number;
  eventsRetentionDays: number;
  ipAllowlist: boolean;
}

interface Counter {
  used?: number;
  n?: number;
  max: number;
}

interface LimitsData {
  access: { tier?: string; name?: string } | null;
  limits: Partial<ApiLimits> | null;
  usage: { period?: string; sync?: Counter; bytes?: Counter; writes?: Counter } | null;
  quota: { sync?: Counter; bytes?: Counter; writes?: Counter; at: string } | null;
  quotaAlerts: Array<{ name: string; pct: number; at: string }>;
  basesInAccess: number;
  peakPerMinute: number;
  limited: { code: string; until: string } | null;
  publicLimits: { tiers?: Record<string, ApiLimits> } | null;
}

const TIERS = ['free', 'solo', 'pro', 'teams', 'enterprise'];
const used = (c?: Counter) => c?.used ?? c?.n ?? 0;

function nextMonthFirst(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

export function Limits() {
  const { data: d, error } = useResource<LimitsData>('/limits', 15_000);
  const tier = d?.access?.tier ?? null;
  // Les compteurs de la dernière réponse (X-Filarr-Quota) priment ; sinon l'usage lu dans `self`
  const sync = d?.quota?.sync ?? d?.usage?.sync;
  const bytes = d?.quota?.bytes ?? d?.usage?.bytes;
  const writes = d?.quota?.writes ?? d?.usage?.writes;
  const lim = d?.limits ?? null;
  const meters = [
    { label: t('Requêtes de synchro'), value: sync ? `${fmtNumber(used(sync))} / ${fmtNumber(sync.max)}` : '—', pct: sync && sync.max ? (used(sync) / sync.max) * 100 : 0, hint: t('Chaque demande de blocs ou de changements à Filarr.') },
    { label: t('Volume descendu'), value: bytes ? `${fmtBytes(used(bytes))} / ${fmtBytes(bytes.max)}` : '—', pct: bytes && bytes.max ? (used(bytes) / bytes.max) * 100 : 0, hint: t('Blocs chiffrés et têtes reçus de Filarr.') },
    {
      label: t('Validations du jour'),
      value: writes ? `${fmtNumber(used(writes))} / ${fmtNumber(writes.max)}` : '—',
      pct: writes && writes.max ? (used(writes) / writes.max) * 100 : 0,
      hint: t('Écritures envoyées à Filarr ; une validation peut porter plusieurs lignes, Filarr ne les voit pas. Remis à zéro à minuit UTC.'),
    },
    {
      label: t('Bases dans cet accès'),
      value: lim?.storesPerAccess ? `${fmtNumber(d?.basesInAccess ?? 0)} / ${fmtNumber(lim.storesPerAccess)}` : fmtNumber(d?.basesInAccess ?? 0),
      pct: lim?.storesPerAccess ? ((d?.basesInAccess ?? 0) / lim.storesPerAccess) * 100 : 0,
      hint: t('Bases qu’un même jeton peut ouvrir.'),
    },
    {
      label: t('Débit vers Filarr'),
      value: lim?.ratePerMinute ? t('pointe {peak} / {max} par minute', { peak: fmtNumber(d?.peakPerMinute ?? 0), max: fmtNumber(lim.ratePerMinute) }) : '—',
      pct: lim?.ratePerMinute ? ((d?.peakPerMinute ?? 0) / lim.ratePerMinute) * 100 : 0,
      hint: t('Par accès. Ne bride pas les lectures locales.'),
    },
  ];
  const tiers = d?.publicLimits?.tiers ?? null;
  const cell = (fn: (l: ApiLimits) => string) => TIERS.map((name) => (tiers?.[name] ? fn(tiers[name]!) : '—'));
  const rows: Array<[string, string[]]> = tiers
    ? [
        [t('Accès API'), cell((l) => fmtNumber(l.accesses))],
        [t('Bases par accès'), cell((l) => fmtNumber(l.storesPerAccess))],
        [t('Écriture (validations)'), cell((l) => (l.write ? t('{n} / jour', { n: fmtNumber(l.writesPerDay) }) : t('lecture seule')))],
        [t('Requêtes de synchro'), cell((l) => t('{n} / mois', { n: fmtNumber(l.syncPerMonth) }))],
        [t('Volume descendu'), cell((l) => t('{n} / mois', { n: fmtBytes(l.bytesPerMonth) }))],
        [t('Débit vers Filarr'), cell((l) => t('{n} / min', { n: fmtNumber(l.ratePerMinute) }))],
        [t('Changements reçus'), cell((l) => (l.stream ? t('en direct') : t('relève {n} min', { n: fmtNumber(l.pollIntervalS / 60, 1) })))],
        [t('Journal des accès (Filarr)'), cell((l) => (l.eventsRetentionDays >= 365 ? t('1 an') : t('{n} jours', { n: l.eventsRetentionDays })))],
        [t('Adresses IP autorisées'), cell((l) => (l.ipAllowlist ? t('oui') : '—'))],
        [t('Lectures servies localement'), TIERS.map(() => t('illimitées'))],
      ]
    : [];

  return (
    <>
      <div class="top">
        <div class="grow">
          <h1>{t('Consommation et limites')}</h1>
          <div class="sub">{t("Filarr ne compte que ce qui passe par lui. Les lectures servies d'ici sont illimitées, à tous les paliers.")}</div>
        </div>
        <span class="badge">
          {tierLabel(tier)} · {t('mois remis à zéro le {date}', { date: fmtDate(nextMonthFirst()) })}
        </span>
      </div>
      <ErrorNotice error={error} />
      {d?.limited ? <div class="notice warn">{t('Filarr limite cet accès ({code}) : reprise à {time}. Les lectures locales continuent.', { code: d.limited.code, time: fmtTime(d.limited.until) })}</div> : null}
      {d?.quotaAlerts.length ? (
        <div class="notice warn">
          {d.quotaAlerts.slice(0, 3).map((a) => (
            <span>{t('Alerte de Filarr : {name} à {pct} % ({time})', { name: a.name, pct: a.pct, time: fmtTime(a.at) })}</span>
          ))}
        </div>
      ) : null}

      <section class="card" aria-labelledby="month">
        <h2 id="month">{t('Ce mois-ci, pour tout le compte')}</h2>
        <p class="hint">{t('Les compteurs sont tenus par Filarr : tous les accès API du compte les partagent.')}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '16px' }}>
          {meters.map((m) => (
            <div>
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '8px', fontSize: '13.5px', marginBottom: '6px' }}>
                <strong>{m.label}</strong>
                <span class="mono">{m.value}</span>
              </div>
              <Meter pct={m.pct} label={m.label} />
              <div style={{ fontSize: '12.5px', color: '#526276', marginTop: '4px' }}>{m.hint}</div>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="tiers">
        <h2 id="tiers" style={{ margin: '0 0 10px', fontSize: '15px' }}>
          {t('Par palier')}
        </h2>
        {tiers ? (
          <div class="table-box">
            <table class="tiers">
              <thead>
                <tr>
                  <th>{t('Limite')}</th>
                  {TIERS.map((name) => (
                    <th class={name === tier ? 'cur' : ''}>{name.charAt(0).toUpperCase() + name.slice(1)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(([label, values]) => (
                  <tr>
                    <td>
                      <strong>{label}</strong>
                    </td>
                    {values.map((v, i) => (
                      <td class={TIERS[i] === tier ? 'cur' : ''}>{TIERS[i] === tier ? <strong>{v}</strong> : v}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div class="notice info">{t('Le barème public de Filarr (/public/api-limits) ne répond pas : seules les limites de cet accès sont connues.')}</div>
        )}
      </section>

      <section class="card" aria-labelledby="over">
        <h2 id="over">{t('Quand une limite est atteinte')}</h2>
        <dl class="kv" style={{ marginTop: '12px' }}>
          <dt>{t('Lectures locales')}</dt>
          <dd>{t('Continuent, sur la dernière copie reçue. Rien ne casse chez vos logiciels.')}</dd>
          <dt>{t('Écritures')}</dt>
          <dd>
            {t('Refusées en 429 avec')} <span class="mono">Retry-After</span>
            {t(", jusqu'au lendemain ou au palier suivant.")}
          </dd>
          <dt>{t('Synchro')}</dt>
          <dd>{t('Passe en relève toutes les 15 minutes jusqu’au mois suivant.')}</dd>
          <dt>{t('Volume')}</dt>
          <dd>{t('Les nouveaux blocs attendent le 1er du mois ; la copie reste servie.')}</dd>
          <dt>{t('Prévenu')}</dt>
          <dd>
            {t('À 80 % puis à 100 %, ici, dans Filarr et par webhook')} <span class="mono">gate.quota</span>.
          </dd>
        </dl>
      </section>
    </>
  );
}
