'use client';

import * as React from 'react';
import type { KbFlowProps, KbStatus, KbTone } from '@agent/core/a2ui-catalog';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  KbChart,
  List,
  Metric,
  Section,
  Skeleton,
  StatusPill,
  Table,
} from '@agent/shared-ui';
import { ChronosDiagram, ChronosInline, ChronosMeta, ChronosToolbar } from './chronos-ui';
import { useChronosLocale } from '../lib/hooks';
import { uxMessage, uxText, type SupportedLocale } from '../lib/ux-vocabulary';
import { parseOrganizationOperatingModelResponse } from '../lib/organization-operating-model-response';

type OrganizationHealth = 'healthy' | 'degraded' | 'critical' | 'unknown';
type OrganizationPriority = 'high' | 'medium' | 'low';

export type OrganizationOperatingModelView = {
  organization_id: string;
  purpose: {
    name: string;
    purpose: string;
    approval_state: 'draft' | 'approved';
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

export function OrganizationOperatingModel({
  tenant,
  onOpenGovernance,
  onOpenOperations,
}: {
  tenant?: string;
  onOpenGovernance?: () => void;
  onOpenOperations?: () => void;
}) {
  const locale = useChronosLocale();
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
      const params = new URLSearchParams();
      if (tenant) params.set('tenant', tenant);
      const response = await fetch(
        `/api/organization-operating-model${params.size ? `?${params.toString()}` : ''}`,
        { cache: 'no-store' }
      );
      const rawPayload: unknown = await response.json().catch(() => null);
      const payload = parseOrganizationOperatingModelResponse(rawPayload);
      if (!response.ok || !payload) throw new Error(`organization ${response.status}`);
      setView(payload.view);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [tenant]);

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

      {!view && !error ? (
        tenant ? (
          <Skeleton shape="card" lines={3} label={uxText('chronos_org_loading', locale)} />
        ) : (
          <EmptyState
            title={uxText('chronos_org_select_tenant_title', locale)}
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
              label={uxText('chronos_org_attention', locale)}
              value={accounting.open_incidents + accounting.pending_decisions}
              tone={
                accounting.open_incidents > 0
                  ? 'danger'
                  : accounting.pending_decisions > 0
                    ? 'warning'
                    : undefined
              }
              description={uxMessage(
                'chronos_org_attention_detail',
                {
                  incidents: accounting.open_incidents,
                  decisions: accounting.pending_decisions,
                },
                `${accounting.open_incidents} incidents · ${accounting.pending_decisions} decisions`,
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
                <>
                  <h4 className="chronos-feed__title">
                    {uxText('chronos_org_objectives', locale)}
                  </h4>
                  <List
                    items={view.purpose.objectives.map((objective) => {
                      const coverage = view.control_plane.outcome_accounting.objectives.find(
                        (entry) => entry.objective_id === objective.objective_id
                      )?.coverage;
                      return {
                        title: objective.title,
                        ...(coverage
                          ? {
                              status: (coverage === 'linked' ? 'connected' : 'missing') as KbStatus,
                              status_label: uxText(
                                coverage === 'linked'
                                  ? 'chronos_org_objective_linked'
                                  : 'chronos_org_objective_unlinked',
                                locale
                              ),
                            }
                          : {}),
                      };
                    })}
                  />
                </>
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
                    { key: 'item', label: uxText('chronos_org_col_item', locale) },
                    { key: 'reason', label: uxText('chronos_org_col_reason', locale) },
                  ]}
                  rows={view.control_plane.intervention_points.slice(0, 6).map((point) => ({
                    priority: {
                      badge: uxText(
                        PRIORITY_LABEL_KEY[point.priority] || PRIORITY_LABEL_KEY.low,
                        locale
                      ),
                      tone: PRIORITY_TONE[point.priority] || 'neutral',
                    },
                    item: { title: point.id, id: point.kind },
                    reason: point.reason,
                  }))}
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
