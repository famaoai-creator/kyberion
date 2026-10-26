/**
 * PI-08: resume a suspended pipeline after its exact approval is decided.
 *
 * This module is intentionally independent of approval-store.ts. The
 * approval store dynamically imports it after persisting the decision, which
 * keeps approval surfaces synchronous and avoids an import cycle.
 */

import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import { spawnManagedProcess } from '../managed-process.js';
import { loadPipelineRunJournal } from './pipeline-run-journal.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath } from '../secure-io.js';
import { buildSystemRoleLaunchEnv } from '../authority.js';
import { pathToFileURL } from 'node:url';
import {
  PIPELINE_RESUME_POLICY_ENV_KEYS,
  restorePipelineResumePolicyEnvironment,
} from './pipeline-resume-policy-env.js';

export type PipelineApprovalResumeOutcome =
  | { status: 'not_applicable'; reason: string }
  | { status: 'already_running'; reason: string; runId: string }
  | { status: 'started'; reason: string; runId: string; resourceId: string };

const pendingResumes = new Set<string>();
/** Install the original scope before importing the canonical runner. URL argv
 * keeps its direct-script guard inactive so main runs exactly once. */
export const PIPELINE_APPROVAL_RESUME_CHILD = `
const runnerUrl = process.argv[1];
const provenance = JSON.parse(process.argv[2]);
const { withScopeEnvOnly } = await import(new URL('../../libs/core/dist/scope-context.js', runnerUrl));
await withScopeEnvOnly(async () => {
  const execute = async () => {
    const { main } = await import(runnerUrl);
    await main(process.argv.slice(3));
  };
  if (!provenance.policy) return execute();
  const { mintScopeEnvelope, withScopeEnvelope } = await import(new URL('../../libs/core/dist/scope-envelope.js', runnerUrl));
  const envelope = mintScopeEnvelope({ identity: provenance.scope, env: {}, policy: provenance.policy });
  return withScopeEnvelope(envelope, execute);
}, provenance.scope);
`;

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function isSafeRunId(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/u.test(value);
}

function approvalBindsToSuspendedRun(
  record: ApprovalRequestRecord,
  runId: string,
  missionId: string | undefined,
  state: ReturnType<typeof loadPipelineRunJournal>
): string | undefined {
  if (state.run_id !== runId) return 'pipeline journal id does not match requested run';
  const context = record.requestedByContext;
  const stepId = nonEmpty(context?.stepId);
  if (!stepId || state.suspended?.step_id !== stepId)
    return 'approval step does not match suspended step';
  if (state.suspended.approval_request_id !== record.id) {
    return 'approval request does not match suspended run';
  }
  if (state.suspended.storage_channel !== record.storageChannel) {
    return 'approval storage channel does not match suspended run';
  }
  if (context?.actorId !== `pipeline:${runId}` || record.requestedBy !== context.actorId) {
    return 'approval requester is not bound to the pipeline run';
  }
  const externalCorrelation = state.suspended.approval_correlation_id;
  if (
    externalCorrelation &&
    (state.suspended.storage_channel !== 'external-operation' ||
      record.channel !== 'external-operation' ||
      !/^external:[a-f0-9]{64}$/u.test(externalCorrelation) ||
      !record.accountability?.effectBinding ||
      !record.accountability?.payloadHash)
  ) {
    return 'external approval binding is incomplete';
  }
  const expectedCorrelation = externalCorrelation || `pipeline:${runId}:${stepId}`;
  if (record.correlationId !== expectedCorrelation) {
    return 'approval correlation is not bound to the pipeline step';
  }
  const startedMissionId = nonEmpty(state.started?.mission_id);
  if (missionId !== startedMissionId) {
    return 'approval mission does not match the pipeline run';
  }
  if (state.finished) return 'pipeline run is already finished';
  return undefined;
}

/**
 * Launch the canonical pipeline runner only when the approval record and
 * suspended journal agree on every durable binding. A malformed or stale
 * approval is reported as a non-starting outcome so callers can retain the
 * operator-visible manual resume path without widening execution authority.
 */
export function resumePipelineRunAfterApproval(
  record: ApprovalRequestRecord
): PipelineApprovalResumeOutcome {
  if (
    !['approved', 'rejected', 'cancelled', 'expired'].includes(record.status) ||
    record.kind !== 'mission_gate'
  ) {
    return { status: 'not_applicable', reason: 'approval is not an approved mission gate' };
  }
  const context = record.requestedByContext;
  const runId = nonEmpty(context?.pipelineRunId);
  if (!runId || !isSafeRunId(runId)) {
    return { status: 'not_applicable', reason: 'approval has no safe pipeline run binding' };
  }
  const missionId = nonEmpty(context?.missionId);
  const resourceId = `pipeline-run-resume:${runId}`;
  if (pendingResumes.has(resourceId)) {
    return {
      status: 'already_running',
      reason: 'pipeline resume launch is already in flight',
      runId,
    };
  }

  const journalScope = record.scope?.tenant_slug
    ? { tier: record.scope.tier, tenantSlug: record.scope.tenant_slug }
    : undefined;
  const state = loadPipelineRunJournal(runId, missionId, journalScope);
  if (record.status !== 'approved' && (!journalScope || !state.started?.library_execution)) {
    return {
      status: 'not_applicable',
      reason: 'terminal denial continuation requires a scoped library journal',
    };
  }
  if (state.finished) {
    return { status: 'not_applicable', reason: 'pipeline run is already finished' };
  }
  const mismatch = approvalBindsToSuspendedRun(record, runId, missionId, state);
  if (mismatch) return { status: 'not_applicable', reason: mismatch };
  if (state.started?.library_execution?.resume_owner === 'task') {
    return {
      status: 'already_running',
      reason: 'task dispatch owns the lease-fenced continuation',
      runId,
    };
  }
  const originalAuthority = state.started?.execution_authority;
  if (
    !originalAuthority?.scope ||
    !originalAuthority.policy_env ||
    PIPELINE_RESUME_POLICY_ENV_KEYS.some(
      (key) => typeof originalAuthority.policy_env[key] !== 'string'
    )
  ) {
    return {
      status: 'not_applicable',
      reason: 'original execution authority is missing; resume from the original runtime',
    };
  }
  if (originalAuthority.unsupported_policy_env?.length) {
    return {
      status: 'not_applicable',
      reason: `original policy controls cannot be restored (${originalAuthority.unsupported_policy_env.join(', ')}); resume from the original runtime with pnpm pipeline --resume ${runId}`,
    };
  }

  const runnerPath = assertSafeRepositoryPath(
    pathResolver.rootResolve('dist/scripts/run_pipeline.js')
  );
  // The approver may be a scheduler or viewer surface with unrelated grants.
  // Restore only the authority captured by the original governed journal writer.
  const scope = originalAuthority.scope;
  const env = buildSystemRoleLaunchEnv(
    {
      ...restorePipelineResumePolicyEnvironment(originalAuthority.policy_env, process.env),
      KYBERION_TIER: scope.tier,
      KYBERION_TENANT: scope.tenant_slug ?? '',
      KYBERION_ORGANIZATION_ID: scope.organization_id ?? '',
      KYBERION_PROJECT_ID: scope.project_id ?? '',
      KYBERION_TASK_ID: scope.task_id ?? '',
      TASK_ID: scope.task_id ?? '',
      KYBERION_SUDO: '',
      KYBERION_SUDO_SCOPE: '',
      KYBERION_SUDO_KEY: '',
      KYBERION_CUSTOMER: scope.customer_stance ?? '',
      KYBERION_VIEWER_PRINCIPAL: scope.viewer_principal ?? '',
      KYBERION_NHI_ACTOR: scope.nhi_id ?? '',
      KYBERION_NHI_ID: originalAuthority.nhi_id,
      KYBERION_AGENT_ID: originalAuthority.agent_id,
      KYBERION_TASK_GRANTS_PATH: originalAuthority.task_grants_path,
      KYBERION_SCOPE_ENV_PATH: '',
    },
    originalAuthority.system_role,
    {
      missionRole: originalAuthority.mission_role,
      persona: originalAuthority.persona,
    }
  );
  if (missionId) env.MISSION_ID = missionId;
  else delete env.MISSION_ID;

  pendingResumes.add(resourceId);
  try {
    const handle = spawnManagedProcess({
      resourceId,
      kind: 'service',
      ownerId: missionId || `pipeline:${runId}`,
      ownerType: 'pipeline-approval-resume',
      command: process.execPath,
      args: [
        '--input-type=module',
        '-e',
        PIPELINE_APPROVAL_RESUME_CHILD,
        pathToFileURL(runnerPath).href,
        JSON.stringify({
          scope,
          ...(originalAuthority.scope_policy ? { policy: originalAuthority.scope_policy } : {}),
        }),
        '--resume',
        runId,
        ...(state.started?.library_execution && journalScope
          ? ['--journal-tier', journalScope.tier, '--journal-tenant', journalScope.tenantSlug!]
          : []),
      ],
      spawnOptions: {
        cwd: pathResolver.rootDir(),
        env,
        detached: true,
        stdio: 'ignore',
      },
      shutdownPolicy: 'detached',
      metadata: {
        pipelineRunId: runId,
        approvalRequestId: record.id,
        ...(missionId ? { missionId } : {}),
        stepId: context?.stepId,
      },
    });
    handle.child.once('exit', () => pendingResumes.delete(resourceId));
  } catch (error) {
    pendingResumes.delete(resourceId);
    throw error;
  }

  return {
    status: 'started',
    reason: `pipeline ${record.status === 'approved' ? 'resume' : 'denial settlement'} started for step ${context?.stepId}`,
    runId,
    resourceId,
  };
}

/** Test seam for a process that wants to await outstanding launch calls. */
export function resetPipelineApprovalResumeState(): void {
  pendingResumes.clear();
}
