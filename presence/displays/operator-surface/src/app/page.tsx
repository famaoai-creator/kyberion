import { Grid, KbChart, Metric, Section, Table, Tabs } from '@agent/shared-ui';
import {
  getCapabilities,
  getCloudflareOsSnapshot,
  getGuardedSurfaceUrl,
  getProviderPins,
  getTenantScope,
  listMissions,
} from '@/lib/data';
import { emitMosRead } from '@/lib/audit-mos';
import { operatorTranslator } from '@/lib/i18n';
import { getRequestLocale } from '@/lib/request-locale';
import { formatCount, missionStatus, statusText, tierLabel, tierTone } from '@/lib/view';
import CapabilityDashboard from '@/components/CapabilityDashboard';
import OsControlPlanePanel from '@/components/OsControlPlanePanel';
import { ROW_HREF, ROW_KEY, tableRows, type OperatorTableRow } from '@/lib/table-rows';
import { OperatorPageHeader } from './operator-shell';

export const dynamic = 'force-dynamic';

const STATUS_ORDER: readonly string[] = [
  'active',
  'distilling',
  'paused',
  'planned',
  'completed',
  'failed',
  'archived',
];

export default async function MissionsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const missions = listMissions();
  const bundles = getCapabilities();
  const pins = getProviderPins();
  const osSnapshot = getCloudflareOsSnapshot();
  const tenantScope = getTenantScope();
  const guardedSurfaceUrl = getGuardedSurfaceUrl();
  emitMosRead({ page: '/', resource_kind: 'mission_list', result_count: missions.length });
  emitMosRead({
    page: '/',
    resource_kind: 'os_control_plane',
    result_count: osSnapshot.heldActions.length + osSnapshot.observations.length,
  });

  const locale = await getRequestLocale();
  const t = operatorTranslator(locale);
  const params = (await searchParams) ?? {};
  const requested = typeof params.status === 'string' ? params.status : 'all';

  // Status counts drive the tabs, the metric row and the chart.
  const counts = new Map<string, number>();
  for (const mission of missions) {
    counts.set(mission.status, (counts.get(mission.status) ?? 0) + 1);
  }
  const statuses = [
    ...STATUS_ORDER.filter((status) => counts.has(status)),
    ...[...counts.keys()].filter((status) => !STATUS_ORDER.includes(status)).sort(),
  ];
  const activeTab = requested !== 'all' && counts.has(requested) ? requested : 'all';
  const visible =
    activeTab === 'all' ? missions : missions.filter((mission) => mission.status === activeTab);
  const statusName = (status: string) => statusText(status, locale, 'mission');
  const failed = counts.get('failed') ?? 0;

  const rows: OperatorTableRow[] = visible.map((mission) => {
    const href = `/missions/${encodeURIComponent(mission.mission_id)}`;
    const pill = missionStatus(mission.status);
    return {
      id: mission.mission_id,
      href,
      cells: {
        mission: { title: mission.title, id: mission.mission_id, href },
        status: { status: pill.status, domain: 'mission', label: pill.label },
        tier: { badge: tierLabel(mission.tier, t), tone: tierTone(mission.tier) },
        tenant: mission.tenant_slug ?? null,
        persona: mission.assigned_persona ?? null,
        checkpoints: formatCount(mission.checkpoints_count ?? 0, locale),
        commit: mission.latest_commit ?? null,
      },
    };
  });

  return (
    <>
      <OperatorPageHeader title={t('missions_title')} subtitle={t('missions_subtitle')} />

      <div className="operator-summary">
        <Grid columns={2} gap="sm">
          <Metric
            label={t('missions_metric_total')}
            value={formatCount(missions.length, locale)}
            tone="accent"
          />
          <Metric
            label={t('missions_metric_active')}
            value={formatCount(counts.get('active') ?? 0, locale)}
            tone="info"
          />
          <Metric
            label={t('missions_metric_completed')}
            value={formatCount(counts.get('completed') ?? 0, locale)}
            tone="success"
          />
          <Metric
            label={t('missions_metric_failed')}
            value={formatCount(failed, locale)}
            tone={failed > 0 ? 'danger' : undefined}
          />
        </Grid>
        <Section title={t('missions_chart_title')}>
          <KbChart
            type="ui:donut"
            props={{
              segments: statuses.map((status) => ({
                label: statusName(status),
                value: counts.get(status) ?? 0,
              })),
              center_label: t('missions_metric_total'),
              center_value: missions.length,
              description: t('missions_chart_description'),
            }}
          />
        </Section>
      </div>

      <Section title={t('missions_list_title')} description={t('missions_list_description')}>
        <Tabs
          label={t('missions_tabs_label')}
          active={activeTab}
          overflow="wrap"
          items={[
            { id: 'all', label: t('missions_tab_all'), count: missions.length, href: '/' },
            ...statuses.map((status) => ({
              id: status,
              label: statusName(status),
              count: counts.get(status) ?? 0,
              href: `/?status=${encodeURIComponent(status)}`,
            })),
          ]}
        />
        <Table
          row_key={ROW_KEY}
          row_href_key={ROW_HREF}
          columns={[
            { key: 'mission', label: t('col_mission') },
            { key: 'status', label: t('col_status') },
            { key: 'tier', label: t('col_tier') },
            { key: 'tenant', label: t('col_tenant'), mono: true },
            { key: 'persona', label: t('col_persona') },
            { key: 'checkpoints', label: t('col_checkpoints'), align: 'end' },
            { key: 'commit', label: t('col_latest_commit'), mono: true },
          ]}
          rows={tableRows(rows)}
          empty={t('missions_empty')}
        />
      </Section>

      <CapabilityDashboard bundles={bundles} pins={pins} locale={locale} />
      <OsControlPlanePanel
        snapshot={osSnapshot}
        tenantScope={tenantScope}
        guardedSurfaceUrl={guardedSurfaceUrl}
        locale={locale}
      />
    </>
  );
}
