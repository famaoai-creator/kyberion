import {
  loadOrganizationOperation,
  listOrganizationOperations,
  listOrganizationOperationRuns,
  loadOrganizationOperationState,
  saveOrganizationOperationRun,
  saveOrganizationOperationState,
  loadOrganizationIncident,
  saveOrganizationIncident,
} from '@agent/core/organization-operating-model-operations';
import { createOrganizationIncident } from '@agent/core/organization-interventions';
import { organizationOperationDueProjection } from '@agent/core/organization-operation-runtime';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { nowIso } from '@agent/core/foundation';
import type {
  OrganizationOperationRun,
  OrganizationOperationState,
} from '@agent/core/organization-operating-model';
import { executePipelineFile } from './run_pipeline.js';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { withLock } from '@agent/core/lock-utils';
import { resolveScopeResolution } from '@agent/core/scope-context';

function operationLockId(organizationId: string, operationId: string, tenantSlug?: string): string {
  return `organization-operation-${createHash('sha256')
    .update(`${tenantSlug || 'shared'}:${organizationId}:${operationId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function operationIncidentId(organizationId: string, runId: string): string {
  return `operation-${createHash('sha256').update(`${organizationId}:${runId}`).digest('hex').slice(0, 32)}`;
}

function assertSelectedOrganizationScope(
  organizationId: string,
  tier: 'public' | 'confidential' | 'personal',
  tenantSlug?: string
): void {
  if (tier === 'public') return;
  const selected = resolveScopeResolution().scope;
  if (
    selected.tier !== tier ||
    selected.tenant_slug !== tenantSlug ||
    (selected.organization_id && selected.organization_id !== organizationId)
  ) {
    throw new Error(
      'Select the matching tier, tenant, and organization with pnpm scope use before executing an organization operation.'
    );
  }
}

function parseFlags(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--apply' || flag === '--dry-run' || flag === '--json') flags.set(flag, 'true');
    else if (flag.startsWith('--') && args[index + 1] && !args[index + 1].startsWith('--'))
      flags.set(flag, args[++index]);
    else throw new Error(`Invalid organization operation argument: ${flag}`);
  }
  if (flags.has('--apply') === flags.has('--dry-run'))
    throw new Error('Specify exactly one of --dry-run or --apply.');
  return flags;
}

export async function executeOrganizationOperation(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const organizationId = flags.get('--organization-id');
  const operationId = flags.get('--operation-id');
  const runId = flags.get('--run-id');
  const tier = flags.get('--tier') as 'public' | 'confidential' | 'personal' | undefined;
  const tenantSlug = flags.get('--tenant-slug');
  if (
    !organizationId ||
    !operationId ||
    !runId ||
    !tier ||
    (tier === 'confidential' && !tenantSlug)
  ) {
    throw new Error(
      '--organization-id, --operation-id, --run-id, --tier, and confidential --tenant-slug are required.'
    );
  }
  assertSelectedOrganizationScope(organizationId, tier, tenantSlug);
  return withLock(
    operationLockId(organizationId, operationId, tenantSlug),
    () =>
      executeOrganizationOperationLocked({
        flags,
        organizationId,
        operationId,
        runId,
        tier,
        tenantSlug,
      }),
    1000
  );
}

async function executeOrganizationOperationLocked(input: {
  flags: Map<string, string>;
  organizationId: string;
  operationId: string;
  runId: string;
  tier: 'public' | 'confidential' | 'personal';
  tenantSlug?: string;
}): Promise<void> {
  const { flags, organizationId, operationId, runId, tier, tenantSlug } = input;
  const operation = loadOrganizationOperation(operationId, { organizationId, tier, tenantSlug });
  if (!operation || operation.status !== 'active')
    throw new Error(`Active operation not found: ${operationId}`);
  const ref = operation.execution_target.ref;
  if (
    operation.execution_target.kind !== 'pipeline' ||
    !ref?.startsWith('pipelines/') ||
    ref.split('/').includes('..') ||
    !safeExistsSync(path.resolve(pathResolver.rootDir(), ref))
  ) {
    throw new Error(
      'Only an existing governed pipelines/ execution target can run through this command.'
    );
  }
  if (
    operation.automation_boundary.approval_required_actions.length ||
    operation.automation_boundary.forbidden_actions.length
  ) {
    throw new Error('This operation requires a separately approved execution path.');
  }
  if (
    listOrganizationOperationRuns({ organizationId, tier, tenantSlug }).some(
      (run) => run.run_id === runId
    )
  ) {
    throw new Error(`Operation run already exists: ${runId}`);
  }
  const mode = flags.has('--apply') ? 'apply' : 'dry_run';
  if (mode === 'dry_run') {
    process.stdout.write(
      `${JSON.stringify({ mode, operation_id: operationId, run_id: runId, execution_ref: ref })}\n`
    );
    return;
  }
  const startedAt = nowIso();
  const started: OrganizationOperationRun = {
    run_id: runId,
    operation_id: operationId,
    organization_id: organizationId,
    tier,
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
    status: 'started',
    started_at: startedAt,
    execution_ref: ref,
    recorded_at: startedAt,
  };
  saveOrganizationOperationRun(started);
  saveOrganizationOperationState({
    operation_id: operationId,
    organization_id: organizationId,
    tier,
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
    status: 'running',
    ...organizationOperationDueProjection(operation, null),
    updated_at: startedAt,
  });
  let status: 'succeeded' | 'failed' = 'succeeded';
  let summary = 'Pipeline completed.';
  let evidenceRefs: string[] = [];
  try {
    const result = await executePipelineFile(ref, {
      payloadScope: {
        tier,
        tenant_slug: tenantSlug,
        purpose: `organization operation ${organizationId}/${operationId}`,
      },
      context: {
        organization_id: organizationId,
        tenant_slug: tenantSlug,
        tier,
        operation_id: operationId,
        operation_run_id: runId,
      },
    });
    evidenceRefs = [`trace:${result.trace.traceId}`];
    if (result.results.some((step) => step.status === 'failed')) {
      status = 'failed';
      summary = 'Pipeline reported a failed step.';
    }
  } catch (error) {
    status = 'failed';
    summary = error instanceof Error ? error.message : String(error);
  }
  const completedAt = nowIso();
  const completed: OrganizationOperationRun = {
    ...started,
    status,
    completed_at: completedAt,
    result_summary: summary,
    evidence_refs: evidenceRefs,
    recorded_at: completedAt,
  };
  const state: OrganizationOperationState = {
    operation_id: operationId,
    organization_id: organizationId,
    tier,
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
    status,
    ...organizationOperationDueProjection(operation, {
      last_run_at: completedAt,
    } as OrganizationOperationState),
    last_run_at: completedAt,
    last_result_summary: summary,
    last_evidence_refs: evidenceRefs,
    updated_at: completedAt,
  };
  saveOrganizationOperationRun(completed);
  saveOrganizationOperationState(state);
  const incidentId = operationIncidentId(organizationId, runId);
  const existingIncident =
    status === 'failed'
      ? loadOrganizationIncident(incidentId, { organizationId, tier, tenantSlug })
      : null;
  if (
    existingIncident &&
    (existingIncident.operation_id !== operationId ||
      !existingIncident.trigger_refs?.includes(`operation-run:${runId}`))
  ) {
    throw new Error(`Incident ID collision for operation run ${runId}.`);
  }
  if (status === 'failed' && !existingIncident) {
    saveOrganizationIncident(
      createOrganizationIncident({
        incidentId,
        organizationId,
        tier,
        tenantSlug,
        title: `Operation ${operationId} failed`,
        severity: 'high',
        ownerRole: operation.owner_role,
        impactSummary: summary,
        serviceId: operation.service_id,
        operationId,
        triggerRefs: [`operation-run:${runId}`],
      })
    );
  }
  process.stdout.write(`${JSON.stringify({ mode, run: completed, state })}\n`);
  if (status === 'failed') throw new Error(`Operation run failed: ${summary}`);
}

/** One bounded catch-up run per due operation; the occurrence-derived ID prevents duplicate ticks. */
export async function tickOrganizationOperations(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const organizationId = flags.get('--organization-id');
  const tier = flags.get('--tier') as 'public' | 'confidential' | 'personal' | undefined;
  const tenantSlug = flags.get('--tenant-slug');
  if (!organizationId || !tier || (tier === 'confidential' && !tenantSlug))
    throw new Error('--organization-id, --tier, and confidential --tenant-slug are required.');
  assertSelectedOrganizationScope(organizationId, tier, tenantSlug);
  const mode = flags.has('--apply') ? 'apply' : 'dry_run';
  const incomplete = listOrganizationOperationRuns({ organizationId, tier, tenantSlug }).filter(
    (run) => run.status === 'started'
  );
  const recovered: string[] = [];
  const active: string[] = [];
  if (mode === 'apply') {
    for (const stale of incomplete) {
      try {
        await withLock(
          operationLockId(organizationId, stale.operation_id, tenantSlug),
          async () => {
            const latest = listOrganizationOperationRuns({ organizationId, tier, tenantSlug }).find(
              (run) => run.run_id === stale.run_id
            );
            if (!latest || latest.status !== 'started') return;
            const operation = loadOrganizationOperation(latest.operation_id, {
              organizationId,
              tier,
              tenantSlug,
            });
            const completedAt = nowIso();
            const summary =
              'Execution stopped before recording a result; operator review required.';
            saveOrganizationOperationRun({
              ...latest,
              status: 'blocked',
              completed_at: completedAt,
              result_summary: summary,
              recorded_at: completedAt,
            });
            const priorState = loadOrganizationOperationState(latest.operation_id, {
              organizationId,
              tier,
              tenantSlug,
            });
            saveOrganizationOperationState({
              operation_id: latest.operation_id,
              organization_id: organizationId,
              tier,
              ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
              status: 'blocked',
              ...(operation
                ? organizationOperationDueProjection(operation, priorState)
                : { due_status: 'unknown' as const }),
              ...(priorState?.last_run_at ? { last_run_at: priorState.last_run_at } : {}),
              last_result_summary: summary,
              updated_at: completedAt,
            });
            const incidentId = operationIncidentId(organizationId, latest.run_id);
            const existingIncident = loadOrganizationIncident(incidentId, {
              organizationId,
              tier,
              tenantSlug,
            });
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
            recovered.push(latest.run_id);
          },
          1000
        );
      } catch (error) {
        if (error instanceof Error && error.message.includes('[LOCK_TIMEOUT]'))
          active.push(stale.run_id);
        else throw error;
      }
    }
  }
  const existingRuns = new Set(
    listOrganizationOperationRuns({ organizationId, tier, tenantSlug }).map((run) => run.run_id)
  );
  const due = listOrganizationOperations({ organizationId, tier, tenantSlug })
    .filter((operation) => operation.status === 'active' && operation.trigger.kind === 'schedule')
    .flatMap((operation) => {
      const projection = organizationOperationDueProjection(
        operation,
        loadOrganizationOperationState(operation.operation_id, { organizationId, tier, tenantSlug })
      );
      if (!projection.next_due_at || !['due', 'overdue'].includes(projection.due_status)) return [];
      const hash = createHash('sha256')
        .update(`${organizationId}:${operation.operation_id}:${projection.next_due_at}`)
        .digest('hex')
        .slice(0, 24);
      const runId = `scheduled-${hash}`;
      return existingRuns.has(runId) ? [] : [{ operation, runId, dueAt: projection.next_due_at }];
    });
  const blocked = due
    .filter(
      ({ operation }) =>
        operation.execution_target.kind !== 'pipeline' ||
        operation.automation_boundary.approval_required_actions.length > 0 ||
        operation.automation_boundary.forbidden_actions.length > 0
    )
    .map(({ operation }) => ({
      operation_id: operation.operation_id,
      reason: 'Requires a separate governed execution path.',
    }));
  const runnable = due.filter(
    ({ operation }) => !blocked.some((entry) => entry.operation_id === operation.operation_id)
  );
  if (mode === 'dry_run') {
    process.stdout.write(
      `${JSON.stringify({ mode, due: due.map(({ operation, runId, dueAt }) => ({ operation_id: operation.operation_id, run_id: runId, due_at: dueAt })), blocked, incomplete_runs: incomplete.map((run) => run.run_id) })}\n`
    );
    return;
  }
  const failures: string[] = [];
  for (const { operation, runId } of runnable) {
    try {
      await executeOrganizationOperation([
        '--organization-id',
        organizationId,
        '--tier',
        tier,
        ...(tenantSlug ? ['--tenant-slug', tenantSlug] : []),
        '--operation-id',
        operation.operation_id,
        '--run-id',
        runId,
        '--apply',
      ]);
    } catch (error) {
      failures.push(
        `${operation.operation_id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  process.stdout.write(
    `${JSON.stringify({ mode, due_count: due.length, run_count: runnable.length, blocked, recovered, active, failures })}\n`
  );
  if (failures.length)
    throw new Error(`Organization operation tick had ${failures.length} failed run(s).`);
}
