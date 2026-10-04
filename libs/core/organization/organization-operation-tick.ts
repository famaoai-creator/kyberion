/**
 * Organization operation tick core (DL-06).
 *
 * One bounded catch-up run per due scheduled operation, plus recovery of runs
 * that stopped before recording a result. Extracted from the
 * `organization_operation_execute` CLI so the scheduled pipeline op and the CLI
 * share one implementation. Execution of a single operation (pipeline
 * invocation) is injected: libs must not import scripts.
 */
import { createHash } from 'node:crypto';
import { nowIso } from '../foundation/time.js';
import { withLock } from '../lock-utils.js';
import { createOrganizationIncident } from './organization-interventions.js';
import {
  listOrganizationOperationRuns,
  listOrganizationOperations,
  loadOrganizationIncident,
  loadOrganizationOperation,
  loadOrganizationOperationState,
  saveOrganizationIncident,
  saveOrganizationOperationRun,
  saveOrganizationOperationState,
} from './organization-operating-model-operations.js';
import { organizationOperationDueProjection } from './organization-operation-runtime.js';
import type { OrganizationTier } from './organization-operating-model.js';

export interface OrganizationScopeRef {
  organizationId: string;
  tier: OrganizationTier;
  /** Directory-level tenant (`shared` for untenanted organizations), as the digest queries it. */
  tenantSlug?: string;
  /** Display name, when discovery knew it. */
  name?: string;
}

export interface TickOptions {
  /** Absent: tick every organization under `tier` (and `tenantSlug` when given). */
  organizationId?: string;
  tier: OrganizationTier;
  tenantSlug?: string;
  apply: boolean;
  now?: Date;
}

export interface TickExecuteInput {
  organizationId: string;
  operationId: string;
  runId: string;
  tier: OrganizationTier;
  tenantSlug?: string;
}

export interface TickDeps {
  /** Runs one operation to completion; rejects when the run failed. */
  executeOperation: (input: TickExecuteInput) => Promise<void>;
  /** Discovers organizations when `organizationId` is absent (see organization-cadence). */
  listOrganizations?: (
    scope: Pick<TickOptions, 'tier' | 'tenantSlug' | 'organizationId'>
  ) => OrganizationScopeRef[];
}

export interface TickDueEntry {
  organization_id: string;
  operation_id: string;
  run_id: string;
  due_at: string;
}

export interface TickReport {
  mode: 'apply' | 'dry_run';
  organizations: number;
  due: TickDueEntry[];
  blocked: Array<{ organization_id: string; operation_id: string; reason: string }>;
  incomplete_runs: string[];
  due_count: number;
  run_count: number;
  recovered: string[];
  active: string[];
  failures: string[];
}

export function operationLockId(
  organizationId: string,
  operationId: string,
  tenantSlug?: string
): string {
  return `organization-operation-${createHash('sha256')
    .update(`${tenantSlug || 'shared'}:${organizationId}:${operationId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

export function operationIncidentId(organizationId: string, runId: string): string {
  return `operation-${createHash('sha256').update(`${organizationId}:${runId}`).digest('hex').slice(0, 32)}`;
}

async function recoverIncompleteRuns(
  scope: OrganizationScopeRef,
  report: TickReport,
  now: Date
): Promise<void> {
  const { organizationId, tier, tenantSlug } = scope;
  const query = { organizationId, tier, tenantSlug };
  const incomplete = listOrganizationOperationRuns(query).filter((run) => run.status === 'started');
  report.incomplete_runs.push(...incomplete.map((run) => run.run_id));
  for (const stale of incomplete) {
    try {
      await withLock(
        operationLockId(organizationId, stale.operation_id, tenantSlug),
        async () => {
          const latest = listOrganizationOperationRuns(query).find(
            (run) => run.run_id === stale.run_id
          );
          if (!latest || latest.status !== 'started') return;
          const operation = loadOrganizationOperation(latest.operation_id, query);
          const completedAt = nowIso();
          const summary = 'Execution stopped before recording a result; operator review required.';
          saveOrganizationOperationRun({
            ...latest,
            status: 'blocked',
            completed_at: completedAt,
            result_summary: summary,
            recorded_at: completedAt,
          });
          const priorState = loadOrganizationOperationState(latest.operation_id, query);
          saveOrganizationOperationState({
            operation_id: latest.operation_id,
            organization_id: organizationId,
            tier,
            ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
            status: 'blocked',
            ...(operation
              ? organizationOperationDueProjection(operation, priorState, now)
              : { due_status: 'unknown' as const }),
            ...(priorState?.last_run_at ? { last_run_at: priorState.last_run_at } : {}),
            last_result_summary: summary,
            updated_at: completedAt,
          });
          const incidentId = operationIncidentId(organizationId, latest.run_id);
          const existingIncident = loadOrganizationIncident(incidentId, query);
          if (
            existingIncident &&
            (existingIncident.operation_id !== latest.operation_id ||
              !existingIncident.trigger_refs?.includes(`operation-run:${latest.run_id}`))
          ) {
            throw new Error(`Incident ID collision for operation run ${latest.run_id}.`);
          }
          if (!existingIncident) {
            saveOrganizationIncident(
              createOrganizationIncident({
                incidentId,
                organizationId,
                tier,
                tenantSlug,
                title: `Operation ${latest.operation_id} interrupted`,
                severity: 'high',
                ownerRole: operation?.owner_role || 'operator',
                impactSummary: summary,
                operationId: latest.operation_id,
                triggerRefs: [`operation-run:${latest.run_id}`],
              })
            );
          }
          report.recovered.push(latest.run_id);
        },
        1000
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('[LOCK_TIMEOUT]'))
        report.active.push(stale.run_id);
      else throw error;
    }
  }
}

async function tickOrganization(
  scope: OrganizationScopeRef,
  options: TickOptions,
  deps: TickDeps,
  report: TickReport
): Promise<void> {
  const { organizationId, tier, tenantSlug } = scope;
  const query = { organizationId, tier, tenantSlug };
  const now = options.now ?? new Date();
  if (options.apply) await recoverIncompleteRuns(scope, report, now);
  else
    report.incomplete_runs.push(
      ...listOrganizationOperationRuns(query)
        .filter((run) => run.status === 'started')
        .map((run) => run.run_id)
    );
  const existingRuns = new Set(listOrganizationOperationRuns(query).map((run) => run.run_id));
  const due = listOrganizationOperations(query)
    .filter((operation) => operation.status === 'active' && operation.trigger.kind === 'schedule')
    .flatMap((operation) => {
      const projection = organizationOperationDueProjection(
        operation,
        loadOrganizationOperationState(operation.operation_id, query),
        now
      );
      if (!projection.next_due_at || !['due', 'overdue'].includes(projection.due_status)) return [];
      const hash = createHash('sha256')
        .update(`${organizationId}:${operation.operation_id}:${projection.next_due_at}`)
        .digest('hex')
        .slice(0, 24);
      const runId = `scheduled-${hash}`;
      return existingRuns.has(runId) ? [] : [{ operation, runId, dueAt: projection.next_due_at }];
    });
  const isBlocked = (operation: (typeof due)[number]['operation']) =>
    operation.execution_target.kind !== 'pipeline' ||
    operation.automation_boundary.approval_required_actions.length > 0 ||
    operation.automation_boundary.forbidden_actions.length > 0;
  report.due.push(
    ...due.map(({ operation, runId, dueAt }) => ({
      organization_id: organizationId,
      operation_id: operation.operation_id,
      run_id: runId,
      due_at: dueAt,
    }))
  );
  report.due_count += due.length;
  report.blocked.push(
    ...due
      .filter(({ operation }) => isBlocked(operation))
      .map(({ operation }) => ({
        organization_id: organizationId,
        operation_id: operation.operation_id,
        reason: 'Requires a separate governed execution path.',
      }))
  );
  if (!options.apply) return;
  for (const { operation, runId } of due.filter(({ operation }) => !isBlocked(operation))) {
    report.run_count += 1;
    try {
      await deps.executeOperation({
        organizationId,
        operationId: operation.operation_id,
        runId,
        tier,
        ...(tenantSlug ? { tenantSlug } : {}),
      });
    } catch (error) {
      report.failures.push(
        `${organizationId}/${operation.operation_id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/**
 * Tick every due scheduled operation. The occurrence-derived run ID makes a
 * repeated tick a no-op for an already-started occurrence. Never throws for a
 * failed operation run; failures are reported in `TickReport.failures`.
 */
export async function tickDueOrganizationOperations(
  options: TickOptions,
  deps: TickDeps
): Promise<TickReport> {
  const scopes = options.organizationId
    ? [
        {
          organizationId: options.organizationId,
          tier: options.tier,
          tenantSlug: options.tenantSlug,
        } satisfies OrganizationScopeRef,
      ]
    : (deps.listOrganizations?.(options) ?? []);
  const report: TickReport = {
    mode: options.apply ? 'apply' : 'dry_run',
    organizations: scopes.length,
    due: [],
    blocked: [],
    incomplete_runs: [],
    due_count: 0,
    run_count: 0,
    recovered: [],
    active: [],
    failures: [],
  };
  for (const scope of scopes) {
    await tickOrganization(scope, options, deps, report);
  }
  return report;
}
