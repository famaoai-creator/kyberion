import { Code, Grid, KbChart, Metric, Section, StatusPill } from '@agent/shared-ui';
import { getHealthSummary, getTenantScope } from '@/lib/data';
import { emitMosRead } from '@/lib/audit-mos';
import { operatorTranslator } from '@/lib/i18n';
import { getRequestLocale } from '@/lib/request-locale';
import { formatCount } from '@/lib/view';
import { OperatorPageHeader } from '../operator-shell';

export const dynamic = 'force-dynamic';

const HEALTH_COMMANDS = [
  'pnpm pipeline --input pipelines/baseline-check.json',
  'pnpm pipeline --input pipelines/full-health-report.json',
  'pnpm watch:tenant-drift',
  'pnpm run check -- --scope full --only contract-schemas',
];

export default async function HealthPage() {
  const h = getHealthSummary();
  const scope = getTenantScope();
  emitMosRead({ page: '/health', resource_kind: 'health' });
  const locale = await getRequestLocale();
  const t = operatorTranslator(locale);

  const finished = h.completed_missions + h.failed_missions;
  const successRate = finished > 0 ? Math.round((h.completed_missions / finished) * 100) : null;
  const overall =
    h.failed_missions > 0 ? 'degraded' : h.recent_override_events > 0 ? 'review' : 'ready';
  const overallLabel =
    overall === 'degraded'
      ? t('health_overall_failed')
      : overall === 'review'
        ? t('health_overall_overrides')
        : t('health_overall_ok');

  return (
    <>
      <OperatorPageHeader
        title={t('health_title')}
        subtitle={scope ? t('health_subtitle_scoped', { tenant: scope }) : t('health_subtitle')}
      />
      <div className="operator-chips">
        <StatusPill status={overall} label={overallLabel} />
      </div>
      <Grid min_column_width="sm" gap="sm">
        <Metric
          label={t('health_active_missions')}
          value={formatCount(h.active_missions, locale)}
          tone="info"
        />
        <Metric
          label={t('health_completed')}
          value={formatCount(h.completed_missions, locale)}
          tone="success"
        />
        <Metric
          label={t('health_failed')}
          value={formatCount(h.failed_missions, locale)}
          tone={h.failed_missions > 0 ? 'danger' : undefined}
        />
        <Metric
          label={t('health_audit_24h')}
          value={formatCount(h.recent_audit_events_24h, locale)}
          tone="accent"
        />
        <Metric
          label={t('health_overrides')}
          value={formatCount(h.recent_override_events, locale)}
          tone={h.recent_override_events > 0 ? 'warning' : undefined}
        />
      </Grid>
      <Grid min_column_width="md" gap="md">
        <Section title={t('health_success_rate_title')}>
          <KbChart
            type="ui:meter"
            props={{
              label: t('health_success_rate_label'),
              value: successRate,
              max: 100,
              unit: '%',
              description: t('health_success_rate_description', {
                completed: formatCount(h.completed_missions, locale),
                finished: formatCount(finished, locale),
              }),
              empty: t('health_success_rate_empty'),
            }}
          />
        </Section>
        <Section title={t('health_mix_title')}>
          <KbChart
            type="ui:bar-chart"
            props={{
              orientation: 'horizontal',
              show_values: true,
              data: [
                { label: t('health_active_missions'), value: h.active_missions },
                { label: t('health_completed'), value: h.completed_missions },
                { label: t('health_failed'), value: h.failed_missions },
              ],
            }}
          />
        </Section>
      </Grid>
      <Section title={t('health_commands_title')} description={t('health_commands_description')}>
        <Code code={HEALTH_COMMANDS.join('\n')} language="shell" />
      </Section>
    </>
  );
}
