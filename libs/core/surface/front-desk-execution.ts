import { assertBuiltinOnlyWorkerEventStream } from '../workforce/worker-event-stream.js';
import {
  isFrontDeskDiagnosticDot,
  requireCurrentFrontDeskDiagnosticDot,
} from '../dot/dot-charter.js';
import {
  hasVerifiedFirstJobDecision,
  hasFirstJobDiagnosticProvenance,
} from './first-job-approval-proof.js';
/** Opt-in diagnostic intake consumer. No generic task execution or authority inference. */
import { createHash } from 'node:crypto';
import { validateReadPermission, validateWritePermission } from '../tier-guard.js';
import { withFrontDeskDispatchLock } from './front-desk-dispatch-lock.js';
import { safeReadFile, safeExistsSync, safeLstat } from '../secure-io.js';
import { writeScopedArtifact } from '../workforce/artifact-store.js';
import { physicalScopedPath } from '../physical-namespace.js';
import { resolveWorkScopeDecision } from '../workforce/work-scope-decision.js';
import { getWorkItem, type WorkItem } from '../workforce/work-coordination.js';
import {
  dispatchDotProposals,
  currentDotActions,
  evaluateDotProposalGate,
  type DotDispatchDeps,
} from '../dot/dot-dispatch.js';
import { runAsDotCharter } from '../dot/dot-key-results.js';
import type { DotCharter, LoadedDotCharter } from '../dot/dot-charter.js';
import type { FrontDeskArtifactVerification } from '../dot/dot-state-paths.js';
import { AUTONOMY_APPROVAL_CHANNEL } from '../governance/approval-decision-card.js';
import { loadApprovalRequest, isApprovalRequestExpired } from '../governance/approval-store.js';
import {
  frontDeskRuntimeScope,
  inspectFrontDeskExecution,
  listConfiguredFrontDeskExecutions,
} from './front-desk-conversation-store.js';
import type { FrontDeskExecutionBinding } from './front-desk-execution-contract.js';

export {
  FRONT_DESK_RECEIPT_PIPELINE,
  frontDeskBindingsEqual,
  frontDeskExecutionProposal,
} from './front-desk-execution-proposal.js';
import {
  FRONT_DESK_RECEIPT_PIPELINE,
  frontDeskBindingsEqual,
  frontDeskExecutionProposal,
} from './front-desk-execution-proposal.js';

/** Durable outbox reader called by the existing supervisor, never from a chat request. */
export async function runFrontDeskExecutionIntake(
  active: readonly LoadedDotCharter[],
  deps: DotDispatchDeps = {}
): Promise<void> {
  const matches = (
    charter: DotCharter,
    mapping: import('./front-desk-execution-contract.js').FrontDeskExecutionMapping
  ): boolean => {
    if (charter.status !== 'active' || charter.dot_id !== mapping.dotId) return false;
    if (isFrontDeskDiagnosticDot(charter) && !deps.assertTenant) return false;
    const scope = frontDeskRuntimeScope(mapping.viewer);
    return (['tenant_slug', 'organization_id', 'project_id', 'tier'] as const).every(
      (key) => (charter.scope[key] ?? undefined) === (scope[key] ?? undefined)
    );
  };
  for (const entry of listConfiguredFrontDeskExecutions((mapping) =>
    active.some(({ charter }) => matches(charter, mapping))
  )) {
    if (entry.request.status !== 'pending') continue;
    const loaded = active.find((value) => matches(value.charter, entry.mapping));
    if (!loaded) continue;
    const charter = loaded.charter;
    if (isFrontDeskDiagnosticDot(charter)) assertBuiltinOnlyWorkerEventStream();
    await runAsDotCharter(charter, async () => {
      // Serialize admission/reconciliation across supervisors. Stable action refs and
      // atomic WorkItem creation independently cover crashes after either write.
      withFrontDeskDispatchLock(entry.binding, () => {
        const admission = inspectFrontDeskExecution(entry.binding, charter, deps);
        if (admission.ok === false) return;
        const existing = getWorkItem(entry.binding.work_item_id);
        if (existing) return; // A terminal/uncertain item is never new work.
        const prior = currentDotActions(charter.dot_id, deps).find((row) =>
          frontDeskBindingsEqual(entry.binding, row.front_desk_execution)
        );
        if (prior) return; // Existing approval/denial/report is reconciled by its owner.
        const shape = resolveWorkScopeDecision({ catalogMinimumShape: 'pipeline' });
        if (shape.execution_shape !== 'pipeline') return;
        dispatchDotProposals(charter, [frontDeskExecutionProposal(entry.binding)], deps);
      });
    });
  }
}

export interface PreparedFrontDeskExecution {
  binding: FrontDeskExecutionBinding;
  artifactPath: string;
  expectedContent: string;
  outputPath: string;
  tenant: string;
  tier: 'public' | 'confidential';
}

/** Fail closed before effects, including on edited/revoked mappings or stale approvals. */
export function prepareFrontDeskExecution(
  charter: DotCharter,
  item: WorkItem,
  deps: Pick<DotDispatchDeps, 'rootDir' | 'now' | 'gate' | 'assertTenant'> = {}
): PreparedFrontDeskExecution {
  const binding = item.metadata?.front_desk_execution as FrontDeskExecutionBinding | undefined;
  if (!binding || binding.work_item_id !== item.item_id) throw new Error('request binding missing');
  const admission = inspectFrontDeskExecution(binding, charter, deps);
  if (admission.ok === false) throw new Error(admission.reason);
  const { mapping } = admission;
  const scope = frontDeskRuntimeScope(mapping.viewer);
  if (isFrontDeskDiagnosticDot(charter)) {
    assertBuiltinOnlyWorkerEventStream();
    if (!deps.assertTenant) throw new Error('diagnostic_requires_bounded_first_job_tick');
    deps.assertTenant(scope.tenant_slug!, {
      charter,
      proposal: frontDeskExecutionProposal(binding),
    });
  }
  if (
    charter.status !== 'active' ||
    !charter.authority.allowed_work_shapes?.includes('pipeline') ||
    !charter.authority.allowed_pipelines?.includes(FRONT_DESK_RECEIPT_PIPELINE)
  )
    throw new Error('configured pipeline capability is unavailable');
  if (
    item.metadata?.pipeline_ref !== FRONT_DESK_RECEIPT_PIPELINE ||
    item.metadata?.requested_work_shape !== 'pipeline' ||
    item.metadata?.dot_id !== charter.dot_id
  )
    throw new Error('WorkItem execution target changed');
  for (const key of ['tenant_slug', 'organization_id', 'project_id'] as const) {
    if (
      (item.context?.[key] ?? undefined) !==
      (scope[key] ?? (key === 'project_id' ? 'default' : undefined))
    )
      throw new Error('WorkItem authority scope changed');
  }
  if (resolveWorkScopeDecision({ catalogMinimumShape: 'pipeline' }).execution_shape !== 'pipeline')
    throw new Error('work-scope policy requires another execution shape');
  const row = currentDotActions(charter.dot_id, deps).find(
    (value) => value.action_ref === item.metadata?.action_ref
  );
  if (
    !row ||
    row.status !== 'dispatched' ||
    row.work_item_id !== item.item_id ||
    !frontDeskBindingsEqual(binding, row.front_desk_execution) ||
    !row.request_id ||
    row.request_id !== item.metadata?.approval_request_id
  )
    throw new Error('approved dispatch evidence missing');
  const approval = loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, row.request_id);
  const diagnostic =
    isFrontDeskDiagnosticDot(charter) || hasFirstJobDiagnosticProvenance(binding, approval);
  if (diagnostic) requireCurrentFrontDeskDiagnosticDot(charter, deps.rootDir);
  // Diagnostic authority expires on the live clock, never a captured sweep timestamp.
  const authorizationNow = diagnostic ? Date.now() : (deps.now?.() ?? new Date()).getTime();
  if (
    !approval ||
    !['approved', 'applied'].includes(approval.status) ||
    approval.decidedByType !== 'human' ||
    isApprovalRequestExpired(approval, authorizationNow)
  )
    throw new Error('current human approval required');
  if (diagnostic && !hasVerifiedFirstJobDecision(approval, charter, binding, authorizationNow))
    throw new Error('verified first-job human approval required');
  if (approval.requestedBy !== 'dot:' + charter.dot_id)
    throw new Error('approval requester mismatch');
  for (const key of [
    'viewer_principal',
    'tenant_slug',
    'organization_id',
    'project_id',
    'tier',
  ] as const) {
    if ((approval.scope?.[key] ?? undefined) !== (scope[key] ?? undefined))
      throw new Error('approval authority scope mismatch');
  }
  const gate = evaluateDotProposalGate(charter, frontDeskExecutionProposal(binding), deps).gate;
  if (gate.shadow || !Number.isFinite(gate.score) || gate.policyVersion === 'unavailable')
    throw new Error('current autonomy policy does not permit execution');
  const tenant = scope.tenant_slug;
  if (!tenant || scope.tier !== 'public')
    throw new Error(
      'diagnostic receipt requires a public input scope; protected input is not downgraded'
    );
  const outputPath = physicalScopedPath(
    'active/shared/runtime/front-desk-execution',
    scope,
    binding.work_item_id + '.json'
  );
  for (const path of [outputPath, admission.artifactPath]) {
    const read = validateReadPermission(path);
    const write = validateWritePermission(path);
    if (!read.allowed || !write.allowed)
      throw new Error(
        'diagnostic artifact capability unavailable: ' + (read.reason ?? write.reason)
      );
  }
  return {
    binding,
    artifactPath: admission.artifactPath,
    expectedContent: admission.expectedContent,
    outputPath,
    tenant,
    tier: scope.tier,
  };
}

/** Step success is insufficient: read exact bytes, publish through canonical artifact IO, read again. */
export function verifyFrontDeskExecution(
  prepared: PreparedFrontDeskExecution
): FrontDeskArtifactVerification {
  if (!safeExistsSync(prepared.outputPath) || !safeLstat(prepared.outputPath).isFile())
    throw new Error('pipeline receipt output missing');
  const content = safeReadFile(prepared.outputPath, { encoding: 'utf8' });
  if (content !== prepared.expectedContent)
    throw new Error('pipeline receipt content does not match the bound request');
  const { binding } = prepared;
  // Publication is create-only by version. A report retry cannot overwrite prior bytes.
  if (safeExistsSync(prepared.artifactPath)) {
    if (
      !safeLstat(prepared.artifactPath).isFile() ||
      safeReadFile(prepared.artifactPath, { encoding: 'utf8' }) !== prepared.expectedContent
    )
      throw new Error('immutable artifact already exists with different bytes');
    return {
      artifact_path: prepared.artifactPath,
      sha256: createHash('sha256').update(prepared.expectedContent).digest('hex'),
      request_digest: binding.request_digest,
      revision: binding.revision,
      verified_at: new Date().toISOString(),
    };
  }
  const published = writeScopedArtifact({
    create_only: true,
    scope: { tenant: prepared.tenant },
    tier: prepared.tier,
    artifact_class: 'report',
    name:
      'front-desk/' +
      binding.conversation_key +
      '/' +
      binding.request_id +
      '-r' +
      binding.revision +
      '.json',
    content,
    format: 'text',
  });
  if (published.repo_relative_path !== prepared.artifactPath)
    throw new Error('artifact scope readback mismatch');
  const readback = safeReadFile(published.repo_relative_path, { encoding: 'utf8' });
  if (readback !== prepared.expectedContent)
    throw new Error('published artifact readback mismatch');
  return {
    artifact_path: published.repo_relative_path,
    sha256: createHash('sha256').update(readback).digest('hex'),
    request_digest: binding.request_digest,
    revision: binding.revision,
    verified_at: new Date().toISOString(),
  };
}
