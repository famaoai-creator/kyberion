import { Callout, Grid, List, Metric, Section, StatusPill, Table } from '@agent/shared-ui';
import { inspectReasoningRoutes } from '@agent/core/reasoning-route-doctor';
import { emitMosRead } from '@/lib/audit-mos';
import { operatorTranslator } from '@/lib/i18n';
import { getRequestLocale } from '@/lib/request-locale';
import { asKbStatus, formatTimestamp } from '@/lib/view';
import { ROW_HREF, ROW_KEY, tableRows, type OperatorTableRow } from '@/lib/table-rows';
import { OperatorPageHeader } from '../operator-shell';

export const dynamic = 'force-dynamic';

export default async function ReasoningPage() {
  const report = await inspectReasoningRoutes();
  emitMosRead({
    page: '/reasoning',
    resource_kind: 'reasoning_routes',
    result_count: report.entries.length,
  });
  const locale = await getRequestLocale();
  const t = operatorTranslator(locale);

  const degraded = report.entries.some((entry) => entry.status === 'degraded');
  const configuration = !report.valid
    ? { status: 'error' as const, label: t('reasoning_config_attention') }
    : degraded
      ? { status: 'fallback' as const, label: t('reasoning_config_degraded') }
      : { status: 'ready' as const, label: t('reasoning_config_ready') };

  const rows: OperatorTableRow[] = report.entries.map((entry) => ({
    id: entry.role,
    cells: {
      role: <span className="operator-mono">{entry.role}</span>,
      selected: <span className="operator-mono">{entry.profileRef ?? '—'}</span>,
      runtime: entry.mode ?? '—',
      model: (
        <span className="operator-mono">{entry.model ?? t('reasoning_provider_default')}</span>
      ),
      status: (
        <StatusPill
          status={entry.status === 'invalid' ? 'error' : (asKbStatus(entry.status) ?? 'n/a')}
          label={entry.status === 'invalid' ? t('reasoning_status_invalid') : undefined}
        />
      ),
      reason: entry.reason,
    },
  }));

  return (
    <>
      <OperatorPageHeader title={t('reasoning_title')} subtitle={t('reasoning_subtitle')} />
      <Grid min_column_width="sm" gap="sm">
        <Metric
          label={t('reasoning_configuration')}
          value={configuration.label}
          tone={
            configuration.status === 'ready'
              ? 'success'
              : configuration.status === 'error'
                ? 'danger'
                : 'warning'
          }
        />
        <Metric
          label={t('reasoning_checked')}
          value={formatTimestamp(report.checkedAt, locale, 'time')}
        />
        <Metric label={t('reasoning_routes')} value={report.entries.length} />
      </Grid>
      <Section title={t('reasoning_routes_title')}>
        <Table
          row_key={ROW_KEY}
          row_href_key={ROW_HREF}
          columns={[
            { key: 'role', label: t('col_role') },
            { key: 'selected', label: t('col_selected') },
            { key: 'runtime', label: t('col_runtime') },
            { key: 'model', label: t('col_model') },
            { key: 'status', label: t('col_status') },
            { key: 'reason', label: t('col_reason') },
          ]}
          rows={tableRows(rows)}
          empty={t('reasoning_empty')}
        />
      </Section>
      {report.nextActions.length > 0 ? (
        <Section title={t('reasoning_next_actions_title')}>
          <List items={report.nextActions.map((action) => ({ title: action }))} />
        </Section>
      ) : (
        <Callout tone="success" title={t('reasoning_no_next_actions')} />
      )}
    </>
  );
}
