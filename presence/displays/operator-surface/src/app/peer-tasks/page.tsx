import { EmptyState, KeyValue, Section } from '@agent/shared-ui';
import { emitMosRead } from '@/lib/audit-mos';
import { getTenantScope } from '@/lib/data';
import { operatorTranslator } from '@/lib/i18n';
import { canReadPeerTasks, isPeerTaskPeerId, readOperatorPeerTasks } from '@/lib/peer-tasks';
import { getRequestLocale } from '@/lib/request-locale';
import { formatTimestamp } from '@/lib/view';
import { requireOperatorViewer } from '@/lib/viewer-context';
import { OperatorPageHeader } from '../operator-shell';

export const dynamic = 'force-dynamic';

export default async function PeerTasksPage({
  searchParams,
}: {
  searchParams: Promise<{ peer?: string | string[] }>;
}) {
  const viewer = await requireOperatorViewer();
  const tenant = getTenantScope();
  const canRead = canReadPeerTasks(viewer, tenant);
  const { peer } = await searchParams;
  const peerId = typeof peer === 'string' ? peer.trim() : '';
  const validPeerId = isPeerTaskPeerId(peerId);
  const rows = readOperatorPeerTasks(viewer, tenant, peerId);
  const locale = await getRequestLocale();
  const t = operatorTranslator(locale);

  emitMosRead({
    page: '/peer-tasks',
    resource_kind: 'peer_tasks',
    result_count: rows.length,
  });

  return (
    <>
      <OperatorPageHeader title={t('peer_tasks_title')} subtitle={t('peer_tasks_subtitle')} />
      {canRead ? (
        <Section title={t('peer_tasks_tenant', { tenant: tenant ?? '' })}>
          <form method="get" action="/peer-tasks" className="operator-card">
            <label htmlFor="peer-task-peer">{t('peer_tasks_peer')}</label>
            <input
              id="peer-task-peer"
              name="peer"
              defaultValue={validPeerId ? peerId : ''}
              required
              pattern={String.raw`[a-z][a-z0-9\-]{1,63}`}
              maxLength={64}
            />
            <button type="submit">{t('peer_tasks_show')}</button>
          </form>
          {peer !== undefined && !validPeerId && (
            <EmptyState title={t('peer_tasks_invalid_peer')} />
          )}
          {validPeerId && rows.length === 0 && <EmptyState title={t('peer_tasks_empty')} />}
          {rows.map((row) => (
            <article key={row.id} id={row.id} className="operator-card">
              <h2 className="operator-mono">{row.id}</h2>
              <KeyValue
                items={[
                  { label: t('peer_tasks_state'), value: t(`peer_tasks_${row.state}`) },
                  { label: t('peer_tasks_type'), value: row.type },
                  { label: t('peer_tasks_requester'), value: row.requester },
                  {
                    label: t('peer_tasks_requested'),
                    value: formatTimestamp(row.requestedAt, locale),
                  },
                  ...(row.workItem
                    ? [{ label: 'WorkItem', value: `${row.workItem.id} · ${row.workItem.status}` }]
                    : []),
                ]}
              />
              {row.artifacts.length > 0 && (
                <details>
                  <summary>{t('peer_tasks_artifacts', { count: row.artifacts.length })}</summary>
                  <ul>
                    {row.artifacts.map((artifact) => (
                      <li key={artifact.ref}>
                        <code>{artifact.ref}</code>
                        <br />
                        <code>SHA-256 {artifact.sha256}</code> · {artifact.bytes} B
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </article>
          ))}
        </Section>
      ) : (
        <EmptyState title={t('peer_tasks_unavailable')} />
      )}
    </>
  );
}
