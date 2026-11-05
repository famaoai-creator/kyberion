'use client';

import { opsApiPath } from '../../lib/ops/ops-api-path';
import * as React from 'react';
import type { KbFlowProps, KbStatus, KbTone } from '@agent/core/surface/a2ui-catalog';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  KbChart,
  Metric,
  Section,
  Skeleton,
  StatusPill,
  Table,
  Tabs,
} from '@agent/shared-ui';
import { localeToBcp47 } from '@agent/core/locale-normalize';
import { ChronosDiagram, ChronosInline, ChronosMeta, ChronosToolbar } from './chronos-ui';
import { useChronosLocale } from '../../lib/ops/hooks';
import { uxMessage, uxText, type SupportedLocale } from '../../lib/ops/ux-vocabulary';
import { parseOrganizationOperatingModelResponse } from '../../lib/ops/organization-operating-model-response';
import { CustomerDecisionCard } from './CustomerDecisionDrilldown';
import { normalizeChronosTenantScopePayload, type ChronosTenantOption } from './tenant-scope-data';
import { entityHref } from '../../lib/workspace-view';
import { CommandDisclosure } from './CommandDisclosure';
import {
  interventionPresentation,
  krView,
  resolveOrganizationTenant,
  type InterventionAction,
  sumAccounting,
  type KrStatus,
  type OrganizationAccountingTotals,
} from './organization-outcome';

type OrganizationHealth = 'healthy' | 'degraded' | 'critical' | 'unknown';
type OrganizationPriority = 'high' | 'medium' | 'low';
type InterventionKind =
  OrganizationOperatingModelView['control_plane']['intervention_points'][number]['kind'];

export function organizationInterventionCommand(
  kind: InterventionKind,
  id: string,
  organizationId: string,
  tenant: string
): string {
  const scope = `--organization-id ${organizationId} --tier confidential --tenant-slug ${tenant}`;
  if (kind === 'incident')
    return `pnpm organization incident list ${scope} --incident-id ${id} --json`;
  if (kind === 'decision')
    return `pnpm organization decision list ${scope} --decision-id ${id} --json`;
  if (kind === 'operation')
    return `pnpm organization operation run list ${scope} --operation-id ${id.split(':')[0]} --json`;
  return `pnpm organization reconcile ${scope} --dry-run --json`;
}

export type OrganizationOperatingModelView = {
  organization_id: string;
  purpose: {
    name: string;
    purpose: string;
    approval_state: 'draft' | 'pending_approval' | 'approved' | 'superseded';
    objectives?: Array<{ objective_id: string; title: string }>;
  } | null;
  operational_state: {
    status: string;
  } | null;
  domains: Array<{
    domain_id: string;
    name: string;
    capability_ids: string[];
    service_ids: string[];
  }>;
  capabilities: Array<{ capability_id: string; name: string; service_ids: string[] }>;
  services: Array<{ service_id: string; name: string; outcome: string; status: string }>;
  service_states: Array<{ service_id: string; health: OrganizationHealth }>;
  operations: Array<{ operation_id: string; name: string; status: string }>;
  operation_states: Array<{ operation_id: string; status: string; due_status?: string }>;
  incidents: Array<{ incident_id: string; title: string; severity: string; status: string }>;
  decisions: Array<{ decision_id: string; title: string; status: string }>;
  solution_projects: Array<{ project_id: string; name: string; status: string }>;
  learning_candidates: Array<{ learning_id: string; title: string; status: string }>;
  reconciliation: {
    status: string;
    overdue_operations: string[];
    stale_services: string[];
    pending_decisions: string[];
  };
  control_plane: {
    accounting: {
      active_projects: number;
      active_services: number;
      healthy_services: number;
      degraded_or_critical_services: number;
      active_operations: number;
      overdue_operations: number;
      open_incidents: number;
      pending_decisions: number;
    };
    intervention_points: Array<{
      kind: 'reconciliation' | 'project' | 'incident' | 'decision' | 'operation';
      id: string;
      priority: OrganizationPriority;
      reason: string;
    }>;
    outcome_accounting: {
      objectives: Array<{
        objective_id: string;
        title: string;
        coverage: 'linked' | 'unlinked';
        progress?: number;
        key_results?: Array<{
          kr_id: string;
          title: string;
          progress?: number;
          measured_at?: string;
          target?: number;
          baseline?: number;
          value?: number;
          direction?: 'increase' | 'decrease' | 'maintain';
          unit?: string;
          history?: Array<{ value: number; progress: number; measured_at: string }>;
        }>;
        projects?: Array<{
          project_id: string;
          name: string;
          status: string;
          mission_ids: string[];
        }>;
      }>;
    };
  };
  readiness: {
    purpose: 'missing' | 'draft' | 'approved';
    operational_state: 'missing' | 'available';
    pending_human_decisions: number;
  };
};

const HEALTH_LABEL_KEY: Record<OrganizationHealth, string> = {
  healthy: 'chronos_org_health_healthy',
  degraded: 'chronos_org_health_degraded',
  critical: 'chronos_org_health_critical',
  unknown: 'chronos_org_health_unknown',
};

const PRIORITY_TONE: Record<OrganizationPriority, KbTone> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

const PRIORITY_LABEL_KEY: Record<OrganizationPriority, string> = {
  high: 'chronos_org_priority_high',
  medium: 'chronos_org_priority_medium',
  low: 'chronos_org_priority_low',
};

/** Service health → canonical `ui:status-pill` status. */
const HEALTH_STATUS: Record<OrganizationHealth, KbStatus> = {
  healthy: 'ready',
  degraded: 'degraded',
  critical: 'error',
  unknown: 'n/a',
};

const FLOW_NODE_LIMIT = 30;

/**
 * The operating structure as a `ui:flow`: domains → capabilities → services
 * (service nodes carry their health), capped so the diagram stays legible.
 */
export function buildOrganizationFlowProps(
  view: Pick<
    OrganizationOperatingModelView,
    'domains' | 'capabilities' | 'services' | 'service_states'
  >,
  locale: SupportedLocale
): KbFlowProps {
  const nodes: KbFlowProps['nodes'] = [];
  const edges: NonNullable<KbFlowProps['edges']> = [];
  const ids = new Set<string>();
  const add = (node: KbFlowProps['nodes'][number]) => {
    if (ids.has(node.id) || nodes.length >= FLOW_NODE_LIMIT) return;
    ids.add(node.id);
    nodes.push(node);
  };
  for (const domain of view.domains)
    add({ id: `domain:${domain.domain_id}`, label: domain.name, stage: 'domain' });
  for (const capability of view.capabilities)
    add({
      id: `capability:${capability.capability_id}`,
      label: capability.name,
      stage: 'capability',
    });
  for (const service of view.services) {
    const health =
      view.service_states.find((state) => state.service_id === service.service_id)?.health ||
      'unknown';
    add({
      id: `service:${service.service_id}`,
      label: service.name,
      stage: 'service',
      status: HEALTH_STATUS[health] ?? 'n/a',
      meta: organizationHealthLabel(health, locale),
    });
  }
  const link = (from: string, to: string) => {
    if (ids.has(from) && ids.has(to)) edges.push({ from, to });
  };
  for (const domain of view.domains) {
    for (const capabilityId of domain.capability_ids)
      link(`domain:${domain.domain_id}`, `capability:${capabilityId}`);
    for (const serviceId of domain.service_ids) {
      const viaCapability = view.capabilities.some(
        (capability) =>
          domain.capability_ids.includes(capability.capability_id) &&
          capability.service_ids.includes(serviceId)
      );
      if (!viaCapability) link(`domain:${domain.domain_id}`, `service:${serviceId}`);
    }
  }
  for (const capability of view.capabilities)
    for (const serviceId of capability.service_ids)
      link(`capability:${capability.capability_id}`, `service:${serviceId}`);
  return {
    nodes,
    edges,
    stages: [
      { id: 'domain', label: uxText('chronos_org_domains', locale) },
      { id: 'capability', label: uxText('chronos_org_capabilities', locale) },
      { id: 'service', label: uxText('chronos_org_services', locale) },
    ],
    density: 'compact',
  };
}

export function organizationHealthLabel(health: string, locale: SupportedLocale): string {
  return uxText(HEALTH_LABEL_KEY[health as OrganizationHealth] || HEALTH_LABEL_KEY.unknown, locale);
}

export function organizationReadinessLabel(
  readiness: OrganizationOperatingModelView['readiness'],
  locale: SupportedLocale
): string {
  if (readiness.purpose === 'approved' && readiness.operational_state === 'available') {
    return uxText('chronos_org_readiness_ready', locale);
  }
  if (readiness.purpose === 'draft') return uxText('chronos_org_readiness_draft', locale);
  return uxText('chronos_org_readiness_setup', locale);
}

async function fetchOrganizationView(params: {
  tenant: string;
  organizationId?: string;
  projectId?: string;
}): Promise<OrganizationOperatingModelView> {
  const query = new URLSearchParams({ tenant: params.tenant });
  if (params.organizationId) query.set('organization_id', params.organizationId);
  if (params.projectId) query.set('project_id', params.projectId);
  const response = await fetch(opsApiPath(`/organization-operating-model?${query.toString()}`), {
    cache: 'no-store',
  });
  const rawPayload: unknown = await response.json().catch(() => null);
  const payload = parseOrganizationOperatingModelResponse(rawPayload);
  if (!response.ok || !payload) {
    const message =
      rawPayload &&
      typeof rawPayload === 'object' &&
      'error' in rawPayload &&
      typeof rawPayload.error === 'string'
        ? rawPayload.error
        : `organization ${response.status}`;
    throw new Error(message);
  }
  return payload.view;
}

/** Tenants the viewer may read (server-resolved); null while loading, [] when unavailable. */
function useScopeTenants(enabled: boolean): ChronosTenantOption[] | null {
  const [tenants, setTenants] = React.useState<ChronosTenantOption[] | null>(null);
  React.useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void fetch(opsApiPath('/tenant-scope'), { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const normalized = response.ok
          ? normalizeChronosTenantScopePayload(await response.json().catch(() => null))
          : null;
        if (!controller.signal.aborted) setTenants(normalized?.tenants ?? []);
      })
      .catch(() => {
        if (!controller.signal.aborted) setTenants([]);
      });
    return () => controller.abort();
  }, [enabled]);
  return tenants;
}

export function OrganizationOperatingModel({
  tenant: selectedTenant,
  organizationId,
  projectId,
  onOpenGovernance,
  onOpenOperations,
}: {
  tenant?: string;
  organizationId?: string;
  projectId?: string;
  onOpenGovernance?: () => void;
  onOpenOperations?: () => void;
}) {
  const locale = useChronosLocale();
  const scopeTenants = useScopeTenants(!selectedTenant);
  const choice = resolveOrganizationTenant(
    selectedTenant,
    (scopeTenants ?? []).map((entry) => entry.slug)
  );
  // With several tenants in scope the console shows their total until one is chosen.
  const [chosenTenant, setChosenTenant] = React.useState('');
  const tenant =
    choice.mode === 'single'
      ? choice.tenant
      : choice.mode === 'multiple' && choice.tenants.includes(chosenTenant)
        ? chosenTenant
        : undefined;
  const tenantName = (slug: string) =>
    scopeTenants?.find((entry) => entry.slug === slug)?.displayName || slug;
  const [view, setView] = React.useState<OrganizationOperatingModelView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    if (!tenant) {
      setView(null);
      setError(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      setView(await fetchOrganizationView({ tenant, organizationId, projectId }));
      setError(null);
    } catch (err) {
      setView(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [tenant, organizationId, projectId]);

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const accounting = view?.control_plane.accounting;
  const flowProps = React.useMemo(
    () => (view ? buildOrganizationFlowProps(view, locale) : null),
    [view, locale]
  );
  const readinessStatus: KbStatus = !view
    ? 'n/a'
    : view.readiness.purpose === 'approved' && view.readiness.operational_state === 'available'
      ? 'ready'
      : view.readiness.purpose === 'draft'
        ? 'planned'
        : 'needs_setup';

  return (
    <Section
      title={uxText('chronos_org_title', locale)}
      description={uxText('chronos_org_description', locale)}
      actions={[
        {
          label: busy
            ? uxText('chronos_ac_refreshing', locale)
            : uxText('chronos_org_refresh', locale),
          variant: 'ghost',
          disabled: busy,
          onClick: () => void refresh(),
        },
      ]}
    >
      {error ? (
        <Callout tone="danger" title={uxText('chronos_org_load_failed', locale)} body={error} />
      ) : null}

      {choice.mode === 'multiple' ? (
        <Tabs
          variant="secondary"
          label={uxText('ux_b_org_tenant_choice', locale)}
          active={tenant ?? ''}
          onSelect={(id) => setChosenTenant(id)}
          items={[
            { id: '', label: uxText('ux_b_org_all_tenants', locale) },
            ...choice.tenants.map((slug) => ({ id: slug, label: tenantName(slug) })),
          ]}
        />
      ) : null}

      {choice.mode === 'multiple' && !tenant ? (
        <OrganizationAggregate
          tenants={choice.tenants}
          tenantName={tenantName}
          organizationId={organizationId}
          locale={locale}
          onChoose={setChosenTenant}
        />
      ) : null}

      {!view && !error && (tenant || choice.mode !== 'multiple') ? (
        tenant || (!selectedTenant && scopeTenants === null) ? (
          <Skeleton shape="card" lines={3} label={uxText('chronos_org_loading', locale)} />
        ) : (
          <EmptyState
            title={uxText('ux_b_org_no_tenants', locale)}
            body={uxText('chronos_organization_scope_hint', locale)}
          />
        )
      ) : null}

      {view && accounting ? (
        <>
          <ChronosInline>
            <Badge label={view.organization_id} tone="accent" />
            {tenant ? <Badge label={`${uxText('chronos_tenant', locale)}: ${tenant}`} /> : null}
            <StatusPill
              status={readinessStatus}
              label={`${uxText('chronos_org_readiness', locale)}: ${organizationReadinessLabel(view.readiness, locale)}`}
            />
            <Badge
              label={`${uxText('chronos_org_reconciliation', locale)}: ${view.reconciliation.status}`}
              tone={view.reconciliation.status === 'ok' ? 'neutral' : 'warning'}
            />
          </ChronosInline>

          <OrganizationStatTiles
            accounting={accounting}
            locale={locale}
            onOpenOperations={onOpenOperations}
            onOpenGovernance={onOpenGovernance}
          />

          <div className="chronos-metrics">
            <Metric
              label={uxText('chronos_org_services', locale)}
              value={`${accounting.healthy_services}/${accounting.active_services}`}
              tone={accounting.degraded_or_critical_services > 0 ? 'warning' : 'success'}
              description={uxMessage(
                'chronos_org_services_detail',
                { degraded: accounting.degraded_or_critical_services },
                `${accounting.degraded_or_critical_services} attention`,
                locale
              )}
            />
            <Metric
              label={uxText('chronos_org_operations', locale)}
              value={accounting.active_operations}
              tone={accounting.overdue_operations > 0 ? 'danger' : undefined}
              description={uxMessage(
                'chronos_org_operations_detail',
                { overdue: accounting.overdue_operations },
                `${accounting.overdue_operations} overdue`,
                locale
              )}
            />
            <Metric
              label={uxText('chronos_org_projects', locale)}
              value={view.solution_projects.length}
            />
            <Metric
              label={uxText('chronos_org_learning', locale)}
              value={view.learning_candidates.length}
            />
          </div>

          <div className="chronos-two-col">
            <Section
              headingLevel={3}
              title={uxText('chronos_org_purpose', locale)}
              tone={view.readiness.purpose === 'approved' ? undefined : 'warning'}
            >
              <p className="kb-text">
                {view.purpose?.purpose || uxText('chronos_org_not_configured', locale)}
              </p>
              {view.purpose?.objectives?.length ? (
                <OrganizationObjectives view={view} locale={locale} />
              ) : (
                <p className="kb-text kb-text--muted">
                  {uxText('chronos_org_no_objectives', locale)}
                </p>
              )}
            </Section>

            <Section headingLevel={3} title={uxText('chronos_org_interventions', locale)}>
              {view.control_plane.intervention_points.length > 0 ? (
                <Table
                  columns={[
                    {
                      key: 'priority',
                      label: uxText('chronos_org_col_priority', locale),
                      width: '7rem',
                    },
                    { key: 'item', label: uxText('ux_b_intervention_col_item', locale) },
                    { key: 'next', label: uxText('ux_b_intervention_col_action', locale) },
                  ]}
                  rows={view.control_plane.intervention_points.slice(0, 6).map((point) => {
                    const shown = interventionPresentation(point);
                    return {
                      priority: {
                        badge: uxText(
                          PRIORITY_LABEL_KEY[point.priority] || PRIORITY_LABEL_KEY.low,
                          locale
                        ),
                        tone: PRIORITY_TONE[point.priority] || 'neutral',
                      },
                      item: (
                        <>
                          <span className="org-intervention__reason">
                            {uxMessage(shown.reason.key, shown.reason.params ?? {}, '', locale)}
                          </span>
                          <span className="org-intervention__id">{point.id}</span>
                        </>
                      ),
                      next: (
                        <div className="org-intervention__action">
                          <InterventionActionButton
                            action={shown.action}
                            id={point.id}
                            locale={locale}
                            onOpenOperations={onOpenOperations}
                            onOpenGovernance={onOpenGovernance}
                          />
                          <CommandDisclosure
                            command={organizationInterventionCommand(
                              point.kind,
                              point.id,
                              view.organization_id,
                              tenant!
                            )}
                          />
                        </div>
                      ),
                    };
                  })}
                />
              ) : (
                <Callout tone="success" title={uxText('chronos_org_no_interventions', locale)} />
              )}
            </Section>
          </div>

          <Section
            headingLevel={3}
            title={uxText('chronos_org_structure', locale)}
            description={uxMessage(
              'chronos_org_structure_counts',
              {
                domains: view.domains.length,
                capabilities: view.capabilities.length,
                services: view.services.length,
              },
              '{domains} domains · {capabilities} capabilities · {services} services',
              locale
            )}
          >
            {flowProps && flowProps.nodes.length > 0 ? (
              <ChronosDiagram>
                <KbChart type="ui:flow" props={flowProps as unknown as Record<string, unknown>} />
              </ChronosDiagram>
            ) : (
              <p className="kb-text kb-text--muted">
                {uxText('chronos_org_structure_empty', locale)}
              </p>
            )}
          </Section>

          {tenant && !projectId ? (
            // `#customer-decisions` is the target of the あなた待ち decision card.
            <div id="customer-decisions">
              <CustomerDecisionCard
                tenant={tenant}
                organizationId={view.organization_id}
                learningCandidates={view.learning_candidates}
              />
            </div>
          ) : null}

          <ChronosToolbar>
            <ChronosMeta>
              {uxMessage(
                'chronos_org_learning_detail',
                { count: view.learning_candidates.length },
                `${view.learning_candidates.length} learning candidates`,
                locale
              )}
            </ChronosMeta>
            <div className="chronos-toolbar__end">
              <ChronosInline>
                {onOpenOperations ? (
                  <Button
                    label={uxText('chronos_org_open_operations', locale)}
                    onClick={onOpenOperations}
                  />
                ) : null}
                {onOpenGovernance ? (
                  <Button
                    variant="primary"
                    label={uxText('chronos_org_open_governance', locale)}
                    onClick={onOpenGovernance}
                  />
                ) : null}
              </ChronosInline>
            </div>
          </ChronosToolbar>
        </>
      ) : null}
    </Section>
  );
}

/** Open incidents / overdue operations / pending decisions, each opening where it is handled. */
function OrganizationStatTiles({
  accounting,
  locale,
  onOpenOperations,
  onOpenGovernance,
  hrefs,
}: {
  accounting: OrganizationAccountingTotals;
  locale: SupportedLocale;
  onOpenOperations?: () => void;
  onOpenGovernance?: () => void;
  /** Links instead of callbacks (the home dashboard opens the console sections). */
  hrefs?: { operations: string; decisions: string };
}) {
  const tiles: Array<{
    key: string;
    value: number;
    tone: 'danger' | 'warning';
    onOpen?: () => void;
    href?: string;
  }> = [
    {
      key: 'ux_b_org_stat_incidents',
      value: accounting.open_incidents,
      tone: 'danger',
      onOpen: onOpenOperations,
      href: hrefs?.operations,
    },
    {
      key: 'ux_b_org_stat_overdue',
      value: accounting.overdue_operations,
      tone: 'warning',
      onOpen: onOpenOperations,
      href: hrefs?.operations,
    },
    {
      key: 'ux_b_org_stat_decisions',
      value: accounting.pending_decisions,
      tone: 'warning',
      onOpen: onOpenGovernance,
      href: hrefs?.decisions,
    },
  ];
  return (
    <div className="org-stats">
      {tiles.map((tile) => {
        const metric = (
          <Metric
            label={uxText(tile.key, locale)}
            value={tile.value}
            tone={tile.value > 0 ? tile.tone : undefined}
            description={
              tile.onOpen || tile.href ? uxText('ux_b_org_stat_open', locale) : undefined
            }
          />
        );
        if (tile.href) {
          return (
            <a key={tile.key} className="org-stat org-stat--link" href={tile.href}>
              {metric}
            </a>
          );
        }
        return tile.onOpen ? (
          <button key={tile.key} type="button" className="org-stat" onClick={tile.onOpen}>
            {metric}
          </button>
        ) : (
          <div key={tile.key} className="org-stat">
            {metric}
          </div>
        );
      })}
    </div>
  );
}

const KR_PILL_STATUS: Record<KrStatus, KbStatus> = {
  met: 'completed',
  on_track: 'ready',
  at_risk: 'degraded',
  off_track: 'blocked',
  unmeasured: 'n/a',
};

type OutcomeObjective =
  OrganizationOperatingModelView['control_plane']['outcome_accounting']['objectives'][number];
type OutcomeKeyResult = NonNullable<OutcomeObjective['key_results']>[number];

/**
 * ARIA value of a KR progressbar. An unmeasured KR has no value (an
 * indeterminate progressbar) and is announced by its status label, never as 0%.
 */
export function krProgressAria(
  percent: number | undefined,
  statusLabel: string
): { 'aria-valuenow'?: number; 'aria-valuetext'?: string } {
  return percent === undefined ? { 'aria-valuetext': statusLabel } : { 'aria-valuenow': percent };
}

function KeyResultRow({ kr, locale }: { kr: OutcomeKeyResult; locale: SupportedLocale }) {
  const bcp47 = localeToBcp47(locale);
  const number = new Intl.NumberFormat(bcp47, { maximumFractionDigits: 2 });
  const format = (value: number | undefined) =>
    value === undefined ? '—' : `${number.format(value)}${kr.unit ? ` ${kr.unit}` : ''}`;
  const reading = krView(kr);
  const values =
    kr.target === undefined
      ? null
      : kr.baseline !== undefined
        ? uxMessage(
            'ux_b_kr_values',
            { baseline: format(kr.baseline), current: format(kr.value), target: format(kr.target) },
            '',
            locale
          )
        : uxMessage(
            'ux_b_kr_values_no_baseline',
            { current: format(kr.value), target: format(kr.target) },
            '',
            locale
          );
  const measured = kr.measured_at
    ? uxMessage(
        'ux_b_kr_measured',
        { date: new Date(kr.measured_at).toLocaleDateString(bcp47) },
        '',
        locale
      )
    : null; // the status pill already says 未計測
  return (
    <li className="org-kr" data-status={reading.status}>
      <div className="org-kr__head">
        <span className="org-kr__title">{kr.title}</span>
        <StatusPill
          status={KR_PILL_STATUS[reading.status]}
          label={uxText(`ux_b_kr_status_${reading.status}`, locale)}
        />
      </div>
      <div className="org-kr__bar">
        <div
          className="org-kr__track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          {...krProgressAria(reading.percent, uxText(`ux_b_kr_status_${reading.status}`, locale))}
          aria-label={kr.title}
        >
          <span className="org-kr__fill" style={{ width: `${reading.percent ?? 0}%` }} />
        </div>
        <span className="org-kr__percent">
          {reading.percent === undefined
            ? '—'
            : uxMessage('ux_b_kr_progress', { percent: reading.percent }, '', locale)}
        </span>
      </div>
      <p className="org-kr__meta">
        {[
          values,
          kr.direction ? uxText(`ux_b_kr_direction_${kr.direction}`, locale) : null,
          measured,
          reading.trend ? uxText(`ux_b_kr_trend_${reading.trend}`, locale) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
    </li>
  );
}

/** Objectives with their key results as progress bars toward the target. */
function OrganizationObjectives({
  view,
  locale,
}: {
  view: OrganizationOperatingModelView;
  locale: SupportedLocale;
}) {
  return (
    <>
      <h4 className="chronos-feed__title">{uxText('ux_b_org_objectives_title', locale)}</h4>
      <ul className="org-objectives">
        {(view.purpose?.objectives ?? []).map((objective) => {
          const entry = view.control_plane.outcome_accounting.objectives.find(
            (candidate) => candidate.objective_id === objective.objective_id
          );
          const projects = entry?.projects?.length
            ? entry.projects
                .map(
                  (project) =>
                    `${project.name || project.project_id} → ${uxMessage('chronos_org_objective_missions', { count: project.mission_ids.length }, `${project.mission_ids.length} missions`, locale)}`
                )
                .join(' · ')
            : uxText('chronos_org_objective_no_projects', locale);
          return (
            <li key={objective.objective_id} className="org-objective">
              <div className="org-objective__head">
                <span className="org-objective__title">{objective.title}</span>
                {entry?.progress !== undefined ? (
                  <span className="org-kr__percent">
                    {uxMessage(
                      'ux_b_kr_progress',
                      { percent: Math.round(entry.progress * 100) },
                      '',
                      locale
                    )}
                  </span>
                ) : null}
                {entry?.coverage ? (
                  <StatusPill
                    status={entry.coverage === 'linked' ? 'connected' : 'missing'}
                    label={uxText(
                      entry.coverage === 'linked'
                        ? 'chronos_org_objective_linked'
                        : 'chronos_org_objective_unlinked',
                      locale
                    )}
                  />
                ) : null}
              </div>
              {entry?.key_results?.length ? (
                <ul className="org-krs">
                  {entry.key_results.map((kr) => (
                    <KeyResultRow key={kr.kr_id} kr={kr} locale={locale} />
                  ))}
                </ul>
              ) : (
                <p className="kb-text kb-text--muted">{uxText('ux_b_objective_no_krs', locale)}</p>
              )}
              <p className="org-kr__meta">{projects}</p>
            </li>
          );
        })}
      </ul>
    </>
  );
}

const AGGREGATE_TENANT_LIMIT = 8;

/** Several tenants in scope: their total, and one row per tenant to open it. */
function OrganizationAggregate({
  tenants,
  tenantName,
  organizationId,
  locale,
  onChoose,
}: {
  tenants: string[];
  tenantName: (slug: string) => string;
  organizationId?: string;
  locale: SupportedLocale;
  onChoose: (slug: string) => void;
}) {
  const shown = tenants.slice(0, AGGREGATE_TENANT_LIMIT);
  const key = shown.join(',');
  const [rows, setRows] = React.useState<Array<{
    slug: string;
    accounting?: OrganizationAccountingTotals;
  }> | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    setRows(null);
    void Promise.all(
      key.split(',').map(async (slug) => {
        try {
          const view = await fetchOrganizationView({ tenant: slug, organizationId });
          return { slug, accounting: view.control_plane.accounting };
        } catch {
          return { slug };
        }
      })
    ).then((result) => {
      if (!cancelled) setRows(result);
    });
    return () => {
      cancelled = true;
    };
  }, [key, organizationId]);

  if (!rows) {
    return <Skeleton shape="card" lines={2} label={uxText('chronos_org_loading', locale)} />;
  }
  const readable = rows.filter((row) => row.accounting);
  const total = sumAccounting(readable.map((row) => row.accounting!));
  const unreadable = rows.length - readable.length;
  return (
    <Section
      headingLevel={3}
      title={uxMessage('ux_b_org_aggregate_title', { count: readable.length }, '', locale)}
      description={uxText('ux_b_org_aggregate_body', locale)}
    >
      <OrganizationStatTiles accounting={total} locale={locale} />
      {unreadable > 0 ? (
        <p className="kb-text kb-text--muted">
          {uxMessage('ux_b_org_aggregate_partial', { count: unreadable }, '', locale)}
        </p>
      ) : null}
      {tenants.length > shown.length ? (
        <p className="kb-text kb-text--muted" role="note">
          {uxMessage(
            'ux_b_org_aggregate_truncated',
            { shown: shown.length, total: tenants.length },
            '',
            locale
          )}
        </p>
      ) : null}
      <Table
        columns={[
          { key: 'tenant', label: uxText('chronos_tenant', locale) },
          { key: 'incidents', label: uxText('ux_b_org_stat_incidents', locale), width: '9rem' },
          { key: 'overdue', label: uxText('ux_b_org_stat_overdue', locale), width: '9rem' },
          { key: 'decisions', label: uxText('ux_b_org_stat_decisions', locale), width: '9rem' },
        ]}
        rows={rows.map((row) => ({
          tenant: (
            <button type="button" className="kb-link" onClick={() => onChoose(row.slug)}>
              {tenantName(row.slug)}
            </button>
          ),
          incidents: row.accounting ? row.accounting.open_incidents : '—',
          overdue: row.accounting ? row.accounting.overdue_operations : '—',
          decisions: row.accounting ? row.accounting.pending_decisions : '—',
        }))}
      />
    </Section>
  );
}

/** The human next step for an intervention: open where it is handled. */
function InterventionActionButton({
  action,
  id,
  locale,
  onOpenOperations,
  onOpenGovernance,
}: {
  action: InterventionAction;
  id: string;
  locale: SupportedLocale;
  onOpenOperations?: () => void;
  onOpenGovernance?: () => void;
}) {
  if (action === 'project') {
    return (
      <a className="kb-btn kb-btn--secondary" href={entityHref('project', id)}>
        {uxText('ux_b_action_open_project', locale)}
      </a>
    );
  }
  const onOpen = action === 'decisions' ? onOpenGovernance : onOpenOperations;
  if (!onOpen) return null;
  return (
    <Button
      variant="secondary"
      label={uxText(
        action === 'decisions' ? 'ux_b_action_open_decisions' : 'ux_b_action_open_operations',
        locale
      )}
      onClick={onOpen}
    />
  );
}

/**
 * The home dashboard's organization block: the same tenant resolution as the
 * 組織 section (the selected tenant, else the only one in scope, else a
 * chooser with the total), the attention tiles and the KR progress bars.
 */
export function OrganizationOutcomeSnapshot({
  tenant: selectedTenant,
  organizationId,
  hrefs,
}: {
  tenant?: string;
  organizationId?: string;
  hrefs: { operations: string; decisions: string };
}) {
  const locale = useChronosLocale();
  const scopeTenants = useScopeTenants(!selectedTenant);
  const choice = resolveOrganizationTenant(
    selectedTenant,
    (scopeTenants ?? []).map((entry) => entry.slug)
  );
  const [chosenTenant, setChosenTenant] = React.useState('');
  const tenant =
    choice.mode === 'single'
      ? choice.tenant
      : choice.mode === 'multiple' && choice.tenants.includes(chosenTenant)
        ? chosenTenant
        : undefined;
  const tenantName = (slug: string) =>
    scopeTenants?.find((entry) => entry.slug === slug)?.displayName || slug;
  const [result, setResult] = React.useState<{
    tenant: string;
    view: OrganizationOperatingModelView | null;
  } | null>(null);
  React.useEffect(() => {
    if (!tenant) return;
    let cancelled = false;
    void fetchOrganizationView({ tenant, organizationId })
      .then((view) => {
        if (!cancelled) setResult({ tenant, view });
      })
      .catch(() => {
        if (!cancelled) setResult({ tenant, view: null });
      });
    return () => {
      cancelled = true;
    };
  }, [tenant, organizationId]);
  const view = result && result.tenant === tenant ? result.view : undefined;

  if (choice.mode === 'none') return null;
  return (
    <Section headingLevel={3} title={uxText('chronos_org_title', locale)}>
      {choice.mode === 'multiple' ? (
        <Tabs
          variant="secondary"
          label={uxText('ux_b_org_tenant_choice', locale)}
          active={tenant ?? ''}
          onSelect={(id) => setChosenTenant(id)}
          items={[
            { id: '', label: uxText('ux_b_org_all_tenants', locale) },
            ...choice.tenants.map((slug) => ({ id: slug, label: tenantName(slug) })),
          ]}
        />
      ) : null}
      {choice.mode === 'multiple' && !tenant ? (
        <OrganizationAggregate
          tenants={choice.tenants}
          tenantName={tenantName}
          organizationId={organizationId}
          locale={locale}
          onChoose={setChosenTenant}
        />
      ) : view === undefined ? (
        <Skeleton shape="card" lines={2} label={uxText('chronos_org_loading', locale)} />
      ) : view === null ? (
        <Callout tone="warning" title={uxText('chronos_org_load_failed', locale)} />
      ) : (
        <>
          <OrganizationStatTiles
            accounting={view.control_plane.accounting}
            locale={locale}
            hrefs={hrefs}
          />
          {view.purpose?.objectives?.length ? (
            <OrganizationObjectives view={view} locale={locale} />
          ) : (
            <p className="kb-text kb-text--muted">{uxText('chronos_org_no_objectives', locale)}</p>
          )}
        </>
      )}
    </Section>
  );
}
