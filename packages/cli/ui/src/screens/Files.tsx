/**
 * Fichiers · la fente à fichiers (`gate-fichiers-1`) : la boîte de dépôt liée à
 * l'accès et sa signature, le filtre qui refuse AVANT tout envoi, les dépôts
 * récents et leur statut (jamais où ni sous quel nom ils ont été rangés).
 */

import { useState } from 'preact/hooks';
import { api } from '../api';
import { Badge, ErrorNotice, useResource } from '../components';
import { fmtAgo, fmtBytes, fmtNumber, t } from '../i18n';

interface FilesData {
  creator: string;
  link: null | { requestId: string; signed: boolean; pending: { n: number; bytes: number }; limits: { maxFileBytes: number; filesPerMonth: number; fileBytesPerMonth: number; pendingMax: number }; usage: { files: number; fileBytes: number } };
  filter: { deny: string[]; allow: string[]; maxBytes: number };
  deposits: Array<{ id: string; status: string; sizeBytes: number; source: string | null; createdAt: string; depositedAt: string | null; filedAt: string | null; error: string | null }>;
}

function statusBadge(status: string) {
  switch (status) {
    case 'filed':
      return <Badge cls="ok">{t('rangé')}</Badge>;
    case 'deposited':
      return <Badge cls="grey">{t('en attente de rangement')}</Badge>;
    case 'rejected':
      return <Badge cls="bad">{t('refusé par l’appli')}</Badge>;
    case 'expired':
      return <Badge cls="warn">{t('expiré')}</Badge>;
    default:
      return <Badge cls="grey">{status}</Badge>;
  }
}

export function Files() {
  const { data, error, reload } = useResource<FilesData>('/files', 5000);
  const [busy, setBusy] = useState(false);
  const [testError, setTestError] = useState<Error | null>(null);
  const test = async () => {
    setBusy(true);
    setTestError(null);
    try {
      await api('POST', '/files/test', {});
      await reload();
    } catch (err) {
      setTestError(err as Error);
    } finally {
      setBusy(false);
    }
  };
  const link = data?.link;
  return (
    <>
      <div class="top">
        <div class="grow">
          <h1>{t('Fichiers reçus')}</h1>
          <div class="sub">{t('Vos logiciels déposent des fichiers par POST /v1/files. La boîte noire les chiffre pour la boîte de dépôt liée ; votre appli Filarr les range. Ni Filarr ni cette boîte ne savent où.')}</div>
        </div>
        <button class="btn" type="button" disabled={busy || !link?.signed} onClick={() => void test()}>
          {t('Déposer un fichier d’essai')}
        </button>
      </div>
      <ErrorNotice error={error ?? testError} />
      <section class="card">
        <h2>{t('Boîte de dépôt')}</h2>
        {!link ? (
          <p class="hint">{t('Aucune boîte de dépôt n’est liée à cet accès. Liez-en une dans Filarr : Réglages › Accès API › Recevoir des fichiers.')}</p>
        ) : (
          <dl class="kv">
            <dt>{t('Signature du créateur')}</dt>
            <dd>{link.signed ? <Badge cls="ok">{t('vérifiée')}</Badge> : <Badge cls="bad">{data?.creator === 'authenticated' ? t('boîte de dépôt non signée') : t('clé du créateur non authentifiée')}</Badge>}</dd>
            <dt>{t('En attente de rangement')}</dt>
            <dd>
              {t('{n} sur {max}', { n: fmtNumber(link.pending.n), max: fmtNumber(link.limits.pendingMax) })} · {fmtBytes(link.pending.bytes)}
            </dd>
            <dt>{t('Ce mois-ci (compte entier)')}</dt>
            <dd>
              {t('{n} fichiers · {bytes}', { n: fmtNumber(link.usage.files), bytes: fmtBytes(link.usage.fileBytes) })}
            </dd>
            <dt>{t('Taille maximale')}</dt>
            <dd>{fmtBytes(Math.min(link.limits.maxFileBytes, data?.filter.maxBytes ?? link.limits.maxFileBytes))}</dd>
          </dl>
        )}
      </section>
      <section class="card">
        <h2>{t('Filtre (avant tout envoi)')}</h2>
        <p class="hint">{t('Refusés par la boîte noire, sans que rien ne parte : les exécutables et scripts, par extension et par signature, et les fichiers trop lourds. Réglable dans Réglages ou gate.toml (files_deny, files_allow, files_max_bytes).')}</p>
        <p class="mono">{data?.filter.allow.length ? t('Seules ces extensions passent : {list}', { list: data.filter.allow.join(' ') }) : t('Extensions refusées : {list}', { list: (data?.filter.deny ?? []).join(' ') })}</p>
      </section>
      <div class="table-box">
        <table>
          <thead>
            <tr>
              <th>{t('Dépôt')}</th>
              <th>{t('Statut')}</th>
              <th>{t('Taille')}</th>
              <th>{t('Clé')}</th>
              <th>{t('Déposé')}</th>
              <th>{t('Rangé')}</th>
            </tr>
          </thead>
          <tbody>
            {(data?.deposits ?? []).map((d) => (
              <tr>
                <td class="mono">{d.id}</td>
                <td>{statusBadge(d.status)}</td>
                <td>{fmtBytes(d.sizeBytes)}</td>
                <td class="mono">{d.source ?? '—'}</td>
                <td>{fmtAgo(d.depositedAt ?? d.createdAt)}</td>
                <td>{fmtAgo(d.filedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.deposits.length === 0 ? <div class="empty">{t('Aucun dépôt pour l’instant.')}</div> : null}
      </div>
    </>
  );
}
