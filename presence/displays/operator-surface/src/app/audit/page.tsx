import Link from 'next/link';
import { KbChart, Section, StatusPill } from '@agent/shared-ui';
import { listRecentAuditEvents, getTenantScope } from '@/lib/data';
import { emitMosRead } from '@/lib/audit-mos';
import { operatorTranslator } from '@/lib/i18n';
import { getRequestLocale } from '@/lib/request-locale';
import { auditResultStatus, formatCount, formatTimestamp } from '@/lib/view';
import { DataTable, type DataTableRow } from '@/components/DataTable';
import { OperatorPageHeader } from '../operator-shell';

export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  // Newest first: the audit log reads as a reverse-chronological timeline.
  const events = listRecentAuditEvents(200)
    .slice()
    .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  emitMosRead({ page: '/audit', resource_kind: 'audit', result_count: events.length });
  const scope = getTenantScope();
  const locale = await getRequestLocale();
  const t = operatorTranslator(locale);

  const byResult = new Map<string, number>();
  for (const event of events) {
    const label = auditResultStatus(event.result, t).label;
    byResult.set(label, (byResult.get(label) ?? 0) + 1);
  }

  const rows: DataTableRow[] = events.map((event) => {
    const result = auditResultStatus(event.result, t);
    return {
      id: event.id,
      cells: {
        time: (
          <span className="operator-mono operator-nowrap" title={event.timestamp}>
            {formatTimestamp(event.timestamp, locale)}
          </span>
        ),
        action: <span className="operator-mono operator-nowrap">{event.action}</span>,
        operation: (
          <span className="operator-mono operator-muted operator-nowrap">{event.operation}</span>
        ),
        result: <StatusPill status={result.status} label={result.label} />,
        tenant: <span className="operator-mono">{event.tenantSlug ?? '—'}</span>,
        mission: event.mission_id ? (
          <Link
            href={`/missions/${encodeURIComponent(event.mission_id)}`}
            className="operator-mono operator-nowrap"
          >
            {event.mission_id}
          </Link>
        ) : (
          '—'
        ),
        reason: event.reason ? (
          <span className="operator-clamp" title={event.reason}>
            {event.reason}
          </span>
        ) : (
          '—'
        ),
      },
    };
  });

  return (
    <>
      <OperatorPageHeader
        title={t('audit_title')}
        subtitle={
          scope
            ? t('audit_subtitle_scoped', {
                count: formatCount(events.length, locale),
                tenant: scope,
              })
            : t('audit_subtitle', { count: formatCount(events.length, locale) })
        }
      />
      {events.length > 0 ? (
        <Section title={t('audit_chart_title')}>
          <KbChart
            type="ui:bar-chart"
            props={{
              orientation: 'horizontal',
              show_values: true,
              data: [...byResult.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([label, value]) => ({ label, value })),
              description: t('audit_chart_description'),
            }}
          />
        </Section>
      ) : null}
      <Section title={t('audit_events_title')} description={t('audit_source_note')}>
        <DataTable
          columns={[
            { key: 'time', label: t('col_time') },
            { key: 'action', label: t('col_action') },
            { key: 'operation', label: t('col_operation') },
            { key: 'result', label: t('col_result') },
            { key: 'tenant', label: t('col_tenant') },
            { key: 'mission', label: t('col_mission') },
            { key: 'reason', label: t('col_reason') },
          ]}
          rows={rows}
          empty={t('audit_empty')}
        />
      </Section>
    </>
  );
}
