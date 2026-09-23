import { Grid, Section, StatusPill, Table } from '@agent/shared-ui';
import type { KbStatus } from '@agent/core/a2ui-catalog';
import { operatorTranslator, type OperatorLocale } from '@/lib/i18n';
import { formatTimestamp } from '@/lib/view';

interface Dependency {
  id: string;
  status: 'available' | 'missing';
  provider: string;
}

interface Bundle {
  bundle_id: string;
  status: string;
  kind: string;
  summary: string;
  health: 'active' | 'degraded' | 'inactive';
  intents?: string[];
  required_actuators?: string[];
  dependencies?: Dependency[];
}

interface CapabilityDashboardProps {
  bundles: Bundle[];
  pins: Record<string, any>;
  locale: OperatorLocale;
}

const HEALTH_STATUS: Record<Bundle['health'], KbStatus> = {
  active: 'ready',
  degraded: 'degraded',
  inactive: 'unavailable',
};

/** Capability bundle matrix + provider pins (read-only; `ui:section` / `ui:status-pill` / `ui:table`). */
export default function CapabilityDashboard({ bundles, pins, locale }: CapabilityDashboardProps) {
  const t = operatorTranslator(locale);
  const healthLabel: Record<Bundle['health'], string> = {
    active: t('capability_health_active'),
    degraded: t('capability_health_degraded'),
    inactive: t('capability_health_inactive'),
  };
  const pinRows = Object.entries(pins).map(([key, pin]: [string, any]) => ({
    key,
    provider: String(pin?.provider ?? '—'),
    model: String(pin?.modelId ?? '—'),
    orchestration: String(pin?.orchestration ?? '—'),
    pinned_at: formatTimestamp(pin?.pinnedAt, locale),
  }));

  return (
    <>
      <Section title={t('capability_title')} description={t('capability_description')}>
        <Grid min_column_width="md" gap="sm">
          {bundles.map((bundle) => (
            <article key={bundle.bundle_id} className="operator-card">
              <div className="operator-card__header">
                <h3 className="operator-card__title operator-mono">{bundle.bundle_id}</h3>
                <StatusPill
                  status={HEALTH_STATUS[bundle.health] ?? 'n/a'}
                  label={healthLabel[bundle.health] ?? bundle.health}
                />
              </div>
              <p className="kb-text kb-text--muted">{bundle.summary}</p>
              <p className="kb-text kb-text--caption">
                {t('capability_intents')}{' '}
                <span className="operator-mono">
                  {(bundle.intents || []).join(', ') || t('value_none')}
                </span>
              </p>
              {bundle.dependencies && bundle.dependencies.length > 0 ? (
                <div className="operator-chips" aria-label={t('capability_dependencies')}>
                  {bundle.dependencies.map((dep) => (
                    <StatusPill
                      key={dep.id}
                      status={dep.status === 'available' ? 'available' : 'missing'}
                      label={t(
                        dep.status === 'available'
                          ? 'capability_dependency_available'
                          : 'capability_dependency_missing',
                        { id: dep.id.replace('provider.runtime.', '') }
                      )}
                    />
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </Grid>
      </Section>

      <Section title={t('pins_title')} description={t('pins_description')}>
        <Table
          columns={[
            { key: 'key', label: t('col_decision_key'), mono: true },
            { key: 'provider', label: t('col_provider') },
            { key: 'model', label: t('col_model'), mono: true },
            { key: 'orchestration', label: t('col_orchestration'), mono: true },
            { key: 'pinned_at', label: t('col_pinned_at') },
          ]}
          rows={pinRows}
          empty={t('pins_empty')}
        />
      </Section>
    </>
  );
}
