'use client';

import {
  BrainCircuit,
  Building2,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  GitBranch,
  RefreshCw,
  ShieldCheck,
  Target,
} from 'lucide-react';
import * as React from 'react';
import { useChronosLocale } from '../lib/hooks';
import { uxMessage, uxText, type SupportedLocale } from '../lib/ux-vocabulary';

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

const PRIORITY_CLASS: Record<OrganizationPriority, string> = {
  high: 'kb-status-negative-border kb-status-negative-surface kb-status-negative',
  medium: 'kb-status-warning-border kb-status-warning-surface kb-status-warning',
  low: 'kb-border-subtle kb-surface-raised kb-text-secondary',
};

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

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  tone = 'neutral',
  compactValue = false,
}: {
  icon: typeof Building2;
  label: string;
  value: string | number;
  detail: React.ReactNode;
  tone?: 'neutral' | 'positive' | 'warning' | 'negative';
  compactValue?: boolean;
}) {
  const toneClass = {
    neutral: 'kb-border-subtle kb-surface-raised kb-text-primary',
    positive: 'kb-status-positive-border kb-status-positive-surface kb-status-positive',
    warning: 'kb-status-warning-border kb-status-warning-surface kb-status-warning',
    negative: 'kb-status-negative-border kb-status-negative-surface kb-status-negative',
  }[tone];
  return (
    <div className={`rounded-2xl border p-3 ${toneClass}`}>
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em]">
        <Icon size={13} />
        <span>{label}</span>
      </div>
      <div
        className={`mt-2 font-semibold tracking-tight ${compactValue ? 'text-sm leading-5' : 'text-2xl'}`}
      >
        {value}
      </div>
      <div className="mt-1 text-[10px] leading-4 opacity-80">{detail}</div>
    </div>
  );
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
      const payload = (await response.json()) as {
        view?: OrganizationOperatingModelView;
        error?: string;
      };
      if (!response.ok || !payload.view)
        throw new Error(payload.error || `organization ${response.status}`);
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

  return (
    <section className="kyberion-glass rounded-[30px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.28em] kb-text-accent">
            <Building2 size={14} />
            {uxText('chronos_nav_organization', locale)}
          </div>
          <h2 className="mt-2 text-xl font-semibold tracking-tight kb-text-primary">
            {uxText('chronos_org_title', locale)}
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 kb-text-secondary">
            {uxText('chronos_org_description', locale)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="flex items-center gap-2 rounded-xl border kb-border-subtle kb-surface-raised px-3 py-2 text-[10px] font-bold uppercase tracking-[0.16em] kb-text-secondary disabled:opacity-50"
        >
          <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
          {uxText('chronos_org_refresh', locale)}
        </button>
      </div>

      {error ? (
        <div className="mt-4 rounded-xl border kb-status-negative-border kb-status-negative-surface px-3 py-2 text-[11px] kb-status-negative">
          {uxText('chronos_org_load_failed', locale)}: {error}
        </div>
      ) : null}

      {!view && !error ? (
        <div className="mt-6 rounded-2xl border kb-border-subtle kb-surface-sunken p-5 text-sm kb-text-muted">
          {tenant
            ? uxText('chronos_org_loading', locale)
            : uxText('chronos_organization_scope_hint', locale)}
        </div>
      ) : null}

      {view ? (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <span className="rounded-full border kb-border-accent kb-surface-accent px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] kb-text-accent">
              {view.organization_id}
            </span>
            {tenant ? (
              <span className="rounded-full border kb-border-subtle kb-surface-raised px-3 py-1 text-[10px] kb-text-secondary">
                tenant: {tenant}
              </span>
            ) : null}
            <span className="rounded-full border kb-border-subtle kb-surface-raised px-3 py-1 text-[10px] kb-text-secondary">
              {uxText('chronos_org_readiness', locale)}:{' '}
              {organizationReadinessLabel(view.readiness, locale)}
            </span>
            <span className="rounded-full border kb-border-subtle kb-surface-raised px-3 py-1 text-[10px] kb-text-secondary">
              {uxText('chronos_org_reconciliation', locale)}: {view.reconciliation.status}
            </span>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              icon={Target}
              label={uxText('chronos_org_purpose', locale)}
              value={view.purpose?.purpose || uxText('chronos_org_not_configured', locale)}
              detail={
                view.purpose?.objectives?.length ? (
                  <div>
                    <div className="mb-1 text-[9px] font-bold uppercase tracking-[0.14em]">
                      {uxText('chronos_org_objectives', locale)}
                    </div>
                    <ul className="list-disc space-y-1 pl-4">
                      {view.purpose.objectives.map((objective) => (
                        <li key={objective.objective_id}>{objective.title}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  uxText('chronos_org_no_objectives', locale)
                )
              }
              tone={view.readiness.purpose === 'approved' ? 'positive' : 'warning'}
              compactValue
            />
            <MetricCard
              icon={ShieldCheck}
              label={uxText('chronos_org_services', locale)}
              value={`${view.control_plane.accounting.healthy_services}/${view.control_plane.accounting.active_services}`}
              detail={uxMessage(
                'chronos_org_services_detail',
                { degraded: view.control_plane.accounting.degraded_or_critical_services },
                `${view.control_plane.accounting.degraded_or_critical_services} attention`,
                locale
              )}
              tone={
                view.control_plane.accounting.degraded_or_critical_services > 0
                  ? 'warning'
                  : 'positive'
              }
            />
            <MetricCard
              icon={Clock3}
              label={uxText('chronos_org_operations', locale)}
              value={view.control_plane.accounting.active_operations}
              detail={uxMessage(
                'chronos_org_operations_detail',
                { overdue: view.control_plane.accounting.overdue_operations },
                `${view.control_plane.accounting.overdue_operations} overdue`,
                locale
              )}
              tone={view.control_plane.accounting.overdue_operations > 0 ? 'negative' : 'neutral'}
            />
            <MetricCard
              icon={CircleAlert}
              label={uxText('chronos_org_attention', locale)}
              value={
                view.control_plane.accounting.open_incidents +
                view.control_plane.accounting.pending_decisions
              }
              detail={uxMessage(
                'chronos_org_attention_detail',
                {
                  incidents: view.control_plane.accounting.open_incidents,
                  decisions: view.control_plane.accounting.pending_decisions,
                },
                `${view.control_plane.accounting.open_incidents} incidents · ${view.control_plane.accounting.pending_decisions} decisions`,
                locale
              )}
              tone={view.control_plane.accounting.open_incidents > 0 ? 'negative' : 'warning'}
            />
          </div>

          <div className="mt-6 grid gap-5 xl:grid-cols-[1.2fr,0.8fr]">
            <div className="rounded-2xl border kb-border-subtle kb-surface-sunken p-4">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] kb-text-secondary">
                <CircleAlert size={14} />
                {uxText('chronos_org_interventions', locale)}
              </div>
              {view.control_plane.intervention_points.length > 0 ? (
                <div className="mt-3 grid gap-2">
                  {view.control_plane.intervention_points.slice(0, 6).map((point) => (
                    <div
                      key={`${point.kind}:${point.id}`}
                      className="flex items-start gap-3 rounded-xl border kb-border-subtle kb-surface-raised p-3"
                    >
                      <span
                        className={`rounded-full border px-2 py-1 text-[9px] font-bold uppercase tracking-[0.12em] ${PRIORITY_CLASS[point.priority]}`}
                      >
                        {point.priority}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-[11px] font-semibold kb-text-primary">
                          {point.id}
                        </div>
                        <div className="mt-1 text-[10px] leading-4 kb-text-muted">
                          {point.reason}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-3 rounded-xl border kb-status-positive-border kb-status-positive-surface p-3 text-[11px] kb-status-positive">
                  <CheckCircle2 className="mr-2 inline-block" size={13} />
                  {uxText('chronos_org_no_interventions', locale)}
                </div>
              )}
            </div>

            <div className="rounded-2xl border kb-border-subtle kb-surface-sunken p-4">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] kb-text-secondary">
                <GitBranch size={14} />
                {uxText('chronos_org_structure', locale)}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                {[
                  [uxText('chronos_org_domains', locale), view.domains.length],
                  [uxText('chronos_org_capabilities', locale), view.capabilities.length],
                  [uxText('chronos_org_projects', locale), view.solution_projects.length],
                  [uxText('chronos_org_learning', locale), view.learning_candidates.length],
                ].map(([label, value]) => (
                  <div
                    key={String(label)}
                    className="rounded-xl border kb-border-subtle kb-surface-raised px-3 py-2"
                  >
                    <div className="kb-text-muted">{label}</div>
                    <div className="mt-1 text-lg font-semibold kb-text-primary">{value}</div>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {view.services.slice(0, 5).map((service) => {
                  const health =
                    view.service_states.find((state) => state.service_id === service.service_id)
                      ?.health || 'unknown';
                  return (
                    <span
                      key={service.service_id}
                      className="rounded-full border kb-border-subtle kb-surface-raised px-2.5 py-1 text-[10px] kb-text-secondary"
                    >
                      <span className="font-semibold kb-text-primary">{service.name}</span> ·{' '}
                      {organizationHealthLabel(health, locale)}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t kb-border-subtle pt-4">
            <div className="flex items-center gap-2 text-[10px] kb-text-muted">
              <BrainCircuit size={13} />
              {uxMessage(
                'chronos_org_learning_detail',
                { count: view.learning_candidates.length },
                `${view.learning_candidates.length} learning candidates`,
                locale
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {onOpenOperations ? (
                <button
                  type="button"
                  onClick={onOpenOperations}
                  className="rounded-xl border kb-border-subtle kb-surface-raised px-3 py-2 text-[10px] font-bold uppercase tracking-[0.16em] kb-text-secondary"
                >
                  {uxText('chronos_org_open_operations', locale)}{' '}
                  <ChevronRight className="ml-1 inline-block" size={12} />
                </button>
              ) : null}
              {onOpenGovernance ? (
                <button
                  type="button"
                  onClick={onOpenGovernance}
                  className="rounded-xl border kb-border-accent kb-surface-accent px-3 py-2 text-[10px] font-bold uppercase tracking-[0.16em] kb-text-accent"
                >
                  {uxText('chronos_org_open_governance', locale)}{' '}
                  <ChevronRight className="ml-1 inline-block" size={12} />
                </button>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
