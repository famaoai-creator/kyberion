import {
  loadOrganizationOperation,
  listOrganizationOperationRuns,
  saveOrganizationOperationRun,
  saveOrganizationOperationState,
  loadOrganizationIncident,
  saveOrganizationIncident,
} from '@agent/core/organization/organization-operating-model-operations';
import { createOrganizationIncident } from '@agent/core/organization/organization-interventions';
import {
  operationIncidentId,
  operationLockId,
  tickDueOrganizationOperations,
  type TickExecuteInput,
} from '@agent/core/organization/organization-operation-tick';
import { organizationOperationDueProjection } from '@agent/core/organization/organization-operation-runtime';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { nowIso } from '@agent/core/foundation';
import type {
  OrganizationOperationRun,
  OrganizationOperationState,
} from '@agent/core/organization/organization-operating-model';
import { executePipelineFile } from './run_pipeline.js';
import * as path from 'node:path';
import { withLock } from '@agent/core/lock-utils';
import { resolveScopeResolution } from '@agent/core/scope-context';
import { withExecutionContextAsync } from '@agent/core/authority';
import { normalizeCadenceTenant } from '@agent/core/organization/organization-cadence';

/**
 * Governed authority role a scheduled (unattended) operation run executes
 * under. The CLI path inherits the operator's selected scope instead.
 */
export const SCHEDULED_OPERATION_ROLE = 'organization_operator';

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
      `Select the matching tier, tenant, and organization with pnpm scope use before executing an organization operation. ` +
        `Expected tier=${tier} tenant=${tenantSlug || '(none)'} organization=${organizationId}, ` +
        `but the current scope is tier=${selected.tier} tenant=${selected.tenant_slug || '(none)'} organization=${selected.organization_id || '(none)'}. ` +
        `Run: pnpm scope use --tier ${tier} --tenant ${tenantSlug || '<slug>'} --organization ${organizationId}`
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
  /** Scheduled runs bind the pipeline to the operation's tenant/organization scope. */
  scheduled?: boolean;
}): Promise<void> {
  const { flags, organizationId, operationId, runId, tier, tenantSlug, scheduled } = input;
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
    const runPipeline = () =>
      executePipelineFile(ref, {
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
    const result = scheduled
      ? await withExecutionContextAsync(
          SCHEDULED_OPERATION_ROLE,
          runPipeline,
          undefined,
          tenantSlug,
          organizationId
        )
      : await runPipeline();
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
  const report = await tickDueOrganizationOperations(
    { organizationId, tier, tenantSlug, apply: flags.has('--apply') },
    { executeOperation: executeScheduledOrganizationOperation }
  );
  const blocked = report.blocked.map(({ operation_id, reason }) => ({ operation_id, reason }));
  if (report.mode === 'dry_run') {
    process.stdout.write(
      `${JSON.stringify({
        mode: report.mode,
        due: report.due.map(({ operation_id, run_id, due_at }) => ({
          operation_id,
          run_id,
          due_at,
        })),
        blocked,
        incomplete_runs: report.incomplete_runs,
      })}\n`
    );
    return;
  }
  process.stdout.write(
    `${JSON.stringify({
      mode: report.mode,
      due_count: report.due_count,
      run_count: report.run_count,
      blocked,
      recovered: report.recovered,
      active: report.active,
      failures: report.failures,
    })}\n`
  );
  if (report.failures.length)
    throw new Error(`Organization operation tick had ${report.failures.length} failed run(s).`);
}

/**
 * Executes one scheduled operation. No selected-scope assertion: the caller is
 * the tick, which enumerates organization scopes itself.
 */
export async function executeScheduledOrganizationOperation(
  input: TickExecuteInput
): Promise<void> {
  const { organizationId, operationId, runId, tier } = input;
  const tenantSlug = normalizeCadenceTenant(input.tenantSlug);
  return withLock(
    operationLockId(organizationId, operationId, tenantSlug),
    () =>
      executeOrganizationOperationLocked({
        flags: new Map([['--apply', 'true']]),
        organizationId,
        operationId,
        runId,
        tier,
        tenantSlug,
        scheduled: true,
      }),
    1000
  );
}
