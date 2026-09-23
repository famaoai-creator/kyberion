import { Badge, Grid, Metric, Section, StatusPill } from '@agent/shared-ui';
import {
  buildSurfaceLauncherRecommendations,
  getSurfaceDirectory,
  getSurfaceDirectorySummary,
  getSurfaceScenarioGuide,
  getTenantScope,
} from '@/lib/data';
import { emitMosRead } from '@/lib/audit-mos';
import { operatorTranslator } from '@/lib/i18n';
import { getRequestLocale } from '@/lib/request-locale';
import { asKbStatus, formatCount, statusText } from '@/lib/view';
import { DataTable, type DataTableRow } from '@/components/DataTable';
import { OperatorPageHeader } from '../operator-shell';

export const dynamic = 'force-dynamic';

export default async function SurfacesPage() {
  const rows = getSurfaceDirectory();
  const summary = getSurfaceDirectorySummary();
  const scenarios = getSurfaceScenarioGuide();
  const recommendations = buildSurfaceLauncherRecommendations({ rows });
  const scope = getTenantScope();
  emitMosRead({ page: '/surfaces', resource_kind: 'surface_directory', result_count: rows.length });
  const locale = await getRequestLocale();
  const t = operatorTranslator(locale);

  const directory: DataTableRow[] = rows.map((row) => ({
    id: row.id,
    cells: {
      surface: (
        <span className="operator-cell operator-cell--primary">
          <span className="operator-cell__title operator-mono">{row.id}</span>
          <span className="operator-cell__meta">{row.description}</span>
          <span className="operator-cell__meta">
            {row.kind} · {row.startup_mode} · {t('surfaces_authority')}{' '}
            <span className="operator-mono">{row.authority_role}</span>
          </span>
        </span>
      ),
      runtime: (
        <span className="operator-cell">
          <StatusPill
            status={asKbStatus(row.runtime_status) ?? 'n/a'}
            domain="runtime"
            label={asKbStatus(row.runtime_status) ? undefined : row.runtime_status}
          />
          <span className="operator-cell__meta">
            {row.enabled ? t('surfaces_enabled_state') : t('surfaces_disabled_state')}
          </span>
          {row.operator_notes ? (
            <span className="operator-cell__meta">{row.operator_notes}</span>
          ) : null}
        </span>
      ),
      auth: (
        <span className="operator-cell">
          <StatusPill
            status={asKbStatus(row.auth_status) ?? 'n/a'}
            domain="connection"
            label={`${row.auth_requirement} / ${statusText(row.auth_status, locale, 'connection')}`}
          />
          <span className="operator-cell__meta">
            {t('surfaces_strategy')} <span className="operator-mono">{row.auth_strategy}</span>
          </span>
          {row.required_secrets.length > 0 ? (
            <span className="operator-cell__meta">
              {t('surfaces_secrets')}{' '}
              <span className="operator-mono">{row.required_secrets.join(', ')}</span>
            </span>
          ) : null}
        </span>
      ),
      use_cases: (
        <span className="operator-chips">
          {row.use_cases.map((useCase) => (
            <Badge key={useCase} label={useCase} tone="neutral" />
          ))}
        </span>
      ),
      fit: (
        <span className="operator-cell">
          <span>{row.best_for}</span>
          <span className="operator-cell__meta">
            {row.blocked_by.length > 0
              ? t('surfaces_blocked_by', { items: row.blocked_by.join(', ') })
              : t('surfaces_blocked_by_none')}
          </span>
        </span>
      ),
      command: <span className="operator-command">{row.next_command}</span>,
    },
  }));

  return (
    <>
      <OperatorPageHeader
        title={t('surfaces_title')}
        subtitle={scope ? t('surfaces_subtitle_scoped', { tenant: scope }) : t('surfaces_subtitle')}
      />
      <Grid min_column_width="xs" gap="sm">
        <Metric
          label={t('surfaces_managed')}
          value={formatCount(summary.total, locale)}
          tone="accent"
        />
        <Metric
          label={t('surfaces_enabled')}
          value={formatCount(summary.enabled, locale)}
          tone="success"
        />
        <Metric
          label={t('surfaces_auth_required')}
          value={formatCount(summary.auth_required, locale)}
        />
        <Metric
          label={t('surfaces_auth_missing')}
          value={formatCount(summary.auth_missing, locale)}
          tone={summary.auth_missing > 0 ? 'danger' : undefined}
        />
        <Metric
          label={t('surfaces_stale')}
          value={formatCount(summary.stale, locale)}
          tone={summary.stale > 0 ? 'warning' : undefined}
        />
        <Metric
          label={t('surfaces_blocked')}
          value={formatCount(summary.blocked, locale)}
          tone={summary.blocked > 0 ? 'warning' : undefined}
        />
      </Grid>

      <Section title={t('surfaces_recommended_title')}>
        <Grid min_column_width="md" gap="sm">
          {recommendations.map((recommendation) => (
            <article key={recommendation.id} className="operator-card">
              <div className="operator-card__header">
                <h3 className="operator-card__title">{recommendation.title}</h3>
                <StatusPill
                  status={asKbStatus(recommendation.readiness) ?? 'n/a'}
                  domain="readiness"
                  label={
                    asKbStatus(recommendation.readiness) ? undefined : recommendation.readiness
                  }
                />
              </div>
              <p className="kb-text kb-text--muted">{recommendation.whenToUse}</p>
              <p className="kb-text kb-text--caption">{recommendation.reason}</p>
              <span className="operator-command">{recommendation.suggestedCommand}</span>
            </article>
          ))}
        </Grid>
      </Section>

      <Section title={t('surfaces_scenarios_title')}>
        <Grid min_column_width="md" gap="sm">
          {scenarios.map((scenario) => (
            <article key={scenario.id} className="operator-card">
              <div className="operator-card__header">
                <h3 className="operator-card__title">{scenario.title}</h3>
              </div>
              <span className="operator-chips">
                {scenario.surface_ids.map((surfaceId) => (
                  <Badge key={surfaceId} label={surfaceId} tone="accent" />
                ))}
              </span>
              <p className="kb-text kb-text--muted">{scenario.summary}</p>
              <p className="kb-text kb-text--caption">{scenario.guidance}</p>
            </article>
          ))}
        </Grid>
      </Section>

      <Section title={t('surfaces_directory_title')}>
        <DataTable
          columns={[
            { key: 'surface', label: t('col_surface') },
            { key: 'runtime', label: t('col_runtime') },
            { key: 'auth', label: t('col_auth') },
            { key: 'use_cases', label: t('col_use_cases') },
            { key: 'fit', label: t('col_fit') },
            { key: 'command', label: t('col_next_command') },
          ]}
          rows={directory}
          empty={t('surfaces_empty')}
        />
      </Section>
    </>
  );
}
