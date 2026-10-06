import type { DotWorkResultRow } from '../../dot/dot-state-paths.js';
import { physicalScopedPath } from '../../physical-namespace.js';
/** Source-loaded child fixture. Every store, authority check and lock is real. */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac } from 'node:crypto';
import { withExecutionContext } from '../../authority.js';
import { safeMkdir, safeLstat, safeWriteFile } from '../../secure-io.js';
import { appendJsonLine, readJsonLines, readJson } from '../../foundation/json.js';
import {
  createWorkItem,
  claimWorkItem,
  releaseWorkItem,
  getWorkItem,
  withUndispatchedWorkItemEvidence,
  readUndispatchedWorkItemEvidence,
} from '../../workforce/work-coordination.js';
import {
  createApprovalRequest,
  decideApprovalRequest,
  loadApprovalRequest,
  computeApprovalPayloadHash,
} from '../../governance/approval-store.js';
import {
  DOT_ACTION_LEDGER_PATH,
  dotActionRecordHash,
  dotProposalHash,
  declineRecoveredDotAction,
  readDotActionLedgerStrict,
  settleDotParkedActions,
  type DotActionRecord,
} from '../../dot/dot-dispatch.js';
import { DOT_WORK_RESULTS_FILE, dotStatePath } from '../../dot/dot-state-paths.js';
import {
  frontDeskExecutionProposal,
  prepareFrontDeskExecution,
} from '../../surface/front-desk-execution.js';
import {
  FRONT_DESK_RECEIPT_COMMAND,
  frontDeskArtifactRevisionCommand,
  frontDeskExecutionExpectedContent,
  getFrontDeskExecutionMapping,
  type FrontDeskExecutionBinding,
} from '../../surface/front-desk-execution-contract.js';
import { frontDeskExecutionArtifactPath } from '../../surface/front-desk-execution-artifact.js';
import { writeScopedArtifact } from '../../workforce/artifact-store.js';
import { appendWorkResult } from '../../dot/dot-executor-reports.js';
import {
  reserveConversationTurn,
  conversationRef,
  listConfiguredFrontDeskExecutions,
  readFrontDeskExecutionRecovery,
  withFrontDeskExecutionRecovery,
  readFrontDeskConversationWork,
  readFrontDeskConversationArtifact,
  readConversationHistory,
  inspectFrontDeskExecution,
  type FrontDeskExecutionRecoveryReceipt,
} from '../../surface/front-desk-conversation-store.js';
import { withFrontDeskDispatchLock } from '../../surface/front-desk-dispatch-lock.js';
import { findDotCharter, type DotCharter } from '../../dot/dot-charter.js';
import {
  firstJobApprovalEffect,
  firstJobApprovalDisplayDigest,
  firstJobProofMessage,
  hasVerifiedFirstJobDecision,
  type FirstJobDecisionProof,
} from '../../surface/first-job-approval-proof.js';
import { writeMemberProfile } from '../../organization/member-registry.js';
import type { MemberProfile } from '../../organization/member-registry.js';
import { nowIso } from '../../foundation/time.js';
import { mintBrowserSessionToken } from '../../authn-providers.js';
import { readFirstJobRecoveries, terminateFirstJobRequest } from '../first-job-recovery.js';
import { getRegisteredEnvText } from '../../foundation/env.js';
const FIRST_JOB_TEST_ISSUER = 'https://fixture.example';
const FIRST_JOB_TEST_SUBJECT = 'fixture-subject';
const FIRST_JOB_TEST_SESSION_KEY = 'synthetic-test-session-key-never-used-outside-tests-123456';
const syntheticFirstJobOwner = (tenant: string): MemberProfile => ({
  member_id: 'owner',
  display_name: 'Synthetic diagnostic owner',
  status: 'active',
  memberships: [{ tenant_slug: tenant, role: 'owner' }],
  access_registrations: [],
  external_identities: [{ issuer: FIRST_JOB_TEST_ISSUER, subject: FIRST_JOB_TEST_SUBJECT }],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});
import { createDraftDotCharter, transitionDotCharterStatus } from '../../dot/dot-lifecycle.js';
import type { SurfaceViewerScope } from '../../surface/surface-mutation-guard.js';

const fixture = 'active/shared/runtime/parked-recovery-fixture.json';
const requestId = '00000000-0000-4000-8000-000000000001';
const viewer: SurfaceViewerScope = {
  source: 'loopback',
  role: 'localadmin',
  principalId: 'human:fixture',
  tenantSlugs: ['fixture-recovery'],
  organizationIds: 'all',
  projectIds: 'all',
  tierAccess: ['public'],
};
const charter: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'fixture-recovery',
  version: '1.0.0',
  title: 'Synthetic recovery',
  purpose: 'Recovery test only',
  status: 'active',
  scope: { tier: 'public', tenant_slug: 'fixture-recovery' },
  goal: { statement: 'Synthetic diagnostic' },
  attention: { triggers: [] },
  authority: {
    authority_role: 'infrastructure_sentinel',
    allowed_work_shapes: ['pipeline'],
    allowed_pipelines: ['pipelines/front-desk-request-receipt.json'],
  },
  decisions: { default_decision: 'approve', escalate_channel: 'surface' },
  notification: { delivery_mode: 'inbox', deliver_to: { surface: 'surface', channel: 'inbox' } },
  runtime: { execution_mode: 'front_desk_diagnostic', heartbeat_id: 'fixture' },
};
function put(file: string, value: unknown): void {
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(value) + '\n');
}
function seed() {
  withExecutionContext('sovereign_concierge', () =>
    writeMemberProfile(syntheticFirstJobOwner('fixture-recovery'))
  );
  createDraftDotCharter({ ...charter, status: 'draft' }, { actor: 'synthetic-test-fixture' });
  transitionDotCharterStatus(charter.dot_id, 'active', { actor: 'synthetic-test-fixture' });
  put('knowledge/product/governance/front-desk-execution-policy.json', {
    version: 1,
    mappings: [
      {
        id: 'fixture-recovery',
        dotId: charter.dot_id,
        viewer,
        exactCommand: FRONT_DESK_RECEIPT_COMMAND,
        pipeline: { path: 'pipelines/front-desk-request-receipt.json', version: 'receipt-v1' },
      },
    ],
  });
  reserveConversationTurn(
    viewer,
    FRONT_DESK_RECEIPT_COMMAND,
    requestId,
    Date.now(),
    undefined,
    undefined,
    { requireDiagnosticAdmission: true }
  );
  const binding = listConfiguredFrontDeskExecutions()[0].binding;
  const effect = firstJobApprovalEffect(findDotCharter(charter.dot_id)!.charter, binding);
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  const approval = createApprovalRequest('infrastructure_sentinel', {
    expiresAt,
    channel: 'inbox',
    storageChannel: 'autonomy',
    threadTs: '',
    correlationId: 'fixture',
    requestedBy: 'dot:' + charter.dot_id,
    accountability: {
      finalDecision: 'human_only',
      payloadHash: effect.payloadHash,
      effectBinding: effect.effectBinding,
    },
    scope: effect.effect.scope as import('../../event-scope.js').EventScopeInput,
    draft: { title: 'Synthetic diagnostic', summary: 'Unverifiable legacy approval fixture' },
  });
  const unsigned: Omit<FirstJobDecisionProof, 'signature'> = {
    version: 1,
    decision: 'approved',
    member_id: 'owner',
    session_id: 'f'.repeat(24),
    session_expires_at: expiresAt,
    identity_digest: computeApprovalPayloadHash({
      issuer: FIRST_JOB_TEST_ISSUER,
      subject: FIRST_JOB_TEST_SUBJECT,
    }),
    issued_at: nowIso(),
    display_digest: firstJobApprovalDisplayDigest(approval, effect, expiresAt),
  };
  const diagnosticDecision = {
    ...unsigned,
    signature: createHmac('sha256', FIRST_JOB_TEST_SESSION_KEY)
      .update(firstJobProofMessage(approval, unsigned))
      .digest('hex'),
  };
  decideApprovalRequest('infrastructure_sentinel', {
    diagnosticDecision,
    channel: 'inbox',
    storageChannel: 'autonomy',
    requestId: approval.id,
    decision: 'approved',
    decidedBy: 'user:owner',
    decidedByType: 'human',
    authenticated: true,
    authMethod: 'surface_session',
    payloadHash: effect.payloadHash,
    effectBinding: effect.effectBinding,
  });
  const persistedApproval = loadApprovalRequest('autonomy', approval.id)!;
  const proposal = frontDeskExecutionProposal(binding);
  const original: DotActionRecord = {
    action_ref: 'frontdesk-' + binding.work_item_id,
    dot_id: charter.dot_id,
    actor_id: 'dot:' + charter.dot_id,
    action_id: proposal.action_id,
    title: proposal.title,
    objective: proposal.objective,
    work_shape: 'pipeline',
    status: 'parked',
    proposal_hash: dotProposalHash(charter.dot_id, proposal),
    decision: 'approve',
    pipeline_ref: proposal.pipeline_ref,
    target: proposal.target,
    intent: proposal.intent,
    request_id: approval.id,
    front_desk_execution: binding,
    at: nowIso(),
  };
  safeMkdir(path.dirname(DOT_ACTION_LEDGER_PATH), { recursive: true });
  appendJsonLine(DOT_ACTION_LEDGER_PATH, original);
  const item = createWorkItem({
    itemId: 'unrelated-fixture',
    title: 'Unrelated',
    description: 'Retained unrelated history',
    status: 'ready',
  });
  const claim = claimWorkItem({
    itemId: item.item_id,
    actorPeerId: 'fixture',
    purpose: 'Synthetic fixture',
  });
  releaseWorkItem({
    itemId: item.item_id,
    leaseId: claim.lease.lease_id,
    actorPeerId: 'fixture',
    nextStatus: 'done',
  });
  const results = dotStatePath(charter, DOT_WORK_RESULTS_FILE);
  safeMkdir(path.dirname(results), { recursive: true });
  safeWriteFile(results, '');
  const receipt: FrontDeskExecutionRecoveryReceipt = {
    version: 1,
    binding,
    action_ref: original.action_ref,
    approval_request_id: approval.id,
    approval_hash: computeApprovalPayloadHash({ value: persistedApproval }),
    action_hash: dotActionRecordHash(original),
    display_digest: 'e'.repeat(64),
    actor_id: 'user:owner',
    member_id: 'owner',
    browser_session_id: 'synthetic-session',
    terminated_at: nowIso(),
    reason: 'approval_verification_failed',
  };
  put(fixture, { binding, original, receipt, approval: persistedApproval });
  return { seeded: true, binding };
}
function seedRevision(validChildProof = false) {
  seed();
  const parentState = readJson(fixture) as {
    binding: FrontDeskExecutionBinding;
    original: DotActionRecord;
  };
  const parent = parentState.binding;
  const mapping = getFrontDeskExecutionMapping(parent)!;
  const body = frontDeskExecutionExpectedContent(
    parent,
    mapping,
    conversationRef(viewer).sessionId
  );
  const sha = createHash('sha256').update(body).digest('hex');
  const artifact = writeScopedArtifact({
    create_only: true,
    scope: { tenant: 'fixture-recovery' },
    tier: 'public',
    artifact_class: 'report',
    name: 'front-desk/' + parent.conversation_key + '/' + parent.request_id + '-r1.json',
    content: body,
    format: 'text',
  });
  createWorkItem({
    itemId: parent.work_item_id,
    title: 'Verified parent fixture',
    description: 'Synthetic completed parent',
    status: 'done',
    context: { tenant_slug: 'fixture-recovery', work_shape: 'routine_operation' },
    metadata: {
      front_desk_execution: parent,
      action_ref: parentState.original.action_ref,
      dot_id: charter.dot_id,
      approval_request_id: parentState.original.request_id,
    },
  });
  appendWorkResult(
    charter,
    {
      dot_id: charter.dot_id,
      work_item_id: parent.work_item_id,
      action_ref: parentState.original.action_ref,
      mode: 'pipeline',
      status: 'done',
      summary: 'Synthetic verified parent',
      started_at: nowIso(),
      completed_at: nowIso(),
      front_desk_verification: {
        artifact_path: artifact.repo_relative_path,
        sha256: sha,
        request_digest: parent.request_digest,
        revision: parent.revision,
        verified_at: nowIso(),
      },
    },
    {}
  );
  appendJsonLine(DOT_ACTION_LEDGER_PATH, {
    ...parentState.original,
    status: 'dispatched',
    work_item_id: parent.work_item_id,
  });
  const childId = '00000000-0000-4000-8000-000000000002';
  reserveConversationTurn(
    viewer,
    frontDeskArtifactRevisionCommand('compact'),
    childId,
    Date.now(),
    undefined,
    { requestId: parent.request_id, revision: parent.revision, sha256: sha, format: 'compact' },
    { requireDiagnosticAdmission: true }
  );
  const binding = listConfiguredFrontDeskExecutions().find(
    (entry) => entry.binding.request_id === childId
  )!.binding;
  const effect = firstJobApprovalEffect(findDotCharter(charter.dot_id)!.charter, binding);
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  const approval = createApprovalRequest('infrastructure_sentinel', {
    expiresAt,
    channel: 'inbox',
    storageChannel: 'autonomy',
    threadTs: '',
    correlationId: 'revision-fixture',
    requestedBy: 'dot:' + charter.dot_id,
    accountability: {
      finalDecision: 'human_only',
      payloadHash: effect.payloadHash,
      effectBinding: effect.effectBinding,
    },
    scope: effect.effect.scope as import('../../event-scope.js').EventScopeInput,
    draft: { title: 'Synthetic parked revision', summary: 'Unverifiable child fixture' },
  });
  const unsigned: Omit<FirstJobDecisionProof, 'signature'> = {
    version: 1,
    decision: 'approved',
    member_id: 'owner',
    session_id: 'f'.repeat(24),
    session_expires_at: expiresAt,
    identity_digest: computeApprovalPayloadHash({
      issuer: FIRST_JOB_TEST_ISSUER,
      subject: FIRST_JOB_TEST_SUBJECT,
    }),
    issued_at: nowIso(),
    display_digest: firstJobApprovalDisplayDigest(approval, effect, expiresAt),
  };
  const diagnosticDecision = validChildProof
    ? {
        ...unsigned,
        signature: createHmac('sha256', FIRST_JOB_TEST_SESSION_KEY)
          .update(firstJobProofMessage(approval, unsigned))
          .digest('hex'),
      }
    : undefined;
  decideApprovalRequest('infrastructure_sentinel', {
    diagnosticDecision,
    channel: 'inbox',
    storageChannel: 'autonomy',
    requestId: approval.id,
    decision: 'approved',
    decidedBy: 'user:owner',
    decidedByType: 'human',
    authenticated: true,
    authMethod: 'surface_session',
    payloadHash: effect.payloadHash,
    effectBinding: effect.effectBinding,
  });
  const persistedApproval = loadApprovalRequest('autonomy', approval.id)!;
  const proposal = frontDeskExecutionProposal(binding);
  const original: DotActionRecord = {
    action_ref: 'frontdesk-' + binding.work_item_id,
    dot_id: charter.dot_id,
    actor_id: 'dot:' + charter.dot_id,
    action_id: proposal.action_id,
    title: proposal.title,
    objective: proposal.objective,
    work_shape: proposal.work_shape,
    status: 'parked',
    proposal_hash: dotProposalHash(charter.dot_id, proposal),
    decision: 'approve',
    pipeline_ref: proposal.pipeline_ref,
    target: proposal.target,
    intent: proposal.intent,
    request_id: approval.id,
    front_desk_execution: binding,
    at: nowIso(),
  };
  appendJsonLine(DOT_ACTION_LEDGER_PATH, original);
  const receipt: FrontDeskExecutionRecoveryReceipt = {
    version: 1,
    binding,
    action_ref: original.action_ref,
    approval_request_id: approval.id,
    approval_hash: computeApprovalPayloadHash({ value: persistedApproval }),
    action_hash: dotActionRecordHash(original),
    display_digest: 'e'.repeat(64),
    actor_id: 'user:owner',
    member_id: 'owner',
    browser_session_id: 'synthetic-session',
    terminated_at: nowIso(),
    reason: 'approval_verification_failed',
  };
  put(fixture, {
    binding,
    original,
    receipt,
    approval: persistedApproval,
    parent,
    parentSha: sha,
    parentBody: body,
  });
  return { seeded: true, binding, parent, parentSha: sha, parentBody: body };
}
function runFacadeSmoke() {
  seed();
  const state = readJson<{
    binding: FrontDeskExecutionBinding;
    receipt: FrontDeskExecutionRecoveryReceipt;
  }>(fixture);
  const token = mintBrowserSessionToken({
    idpIssuer: FIRST_JOB_TEST_ISSUER,
    subject: FIRST_JOB_TEST_SUBJECT,
    ttlSeconds: 1800,
  }).token;
  const session_id = conversationRef(viewer).sessionId;
  const before = readFirstJobRecoveries(viewer, token, { session_id });
  if (before.length !== 1 || before[0].status !== 'eligible')
    throw new Error('actual recovery facade did not expose the guarded fixture');
  const result = terminateFirstJobRequest(viewer, token, state.binding.request_id, {
    action: 'terminate_unstarted',
    session_id,
    display_digest: before[0].display_digest,
  });
  const after = readFirstJobRecoveries(viewer, token, { session_id });
  return {
    before,
    result,
    after,
    originalApprovalUnchanged:
      computeApprovalPayloadHash({
        value: loadApprovalRequest('autonomy', state.receipt.approval_request_id),
      }) === state.receipt.approval_hash,
    workItem: getWorkItem(state.binding.work_item_id),
  };
}
function runStaleLineage() {
  seedRevision(true);
  const state = readJson<{
    binding: FrontDeskExecutionBinding;
    parent: FrontDeskExecutionBinding;
    original: DotActionRecord;
    receipt: FrontDeskExecutionRecoveryReceipt;
  }>(fixture);
  const parentPath = frontDeskExecutionArtifactPath(
    state.parent,
    getFrontDeskExecutionMapping(state.parent)!
  );
  // Fault injection is limited to this guarded synthetic test root.
  safeWriteFile(parentPath, 'tampered parent bytes after child approval');
  const proofValid = hasVerifiedFirstJobDecision(
    loadApprovalRequest('autonomy', state.receipt.approval_request_id)!,
    charter,
    state.binding
  );
  settleDotParkedActions(charter, { assertTenant: () => undefined });
  const item = getWorkItem(state.binding.work_item_id);
  if (!item) throw new Error('stale lineage fixture expected a coordination item');
  let preparationError: string | undefined;
  try {
    prepareFrontDeskExecution(charter, item, { assertTenant: () => undefined });
  } catch (error) {
    preparationError = String(error);
  }
  const absent = (file: string): boolean => {
    try {
      safeLstat(file);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  };
  const childArtifact = frontDeskExecutionArtifactPath(
    state.binding,
    getFrontDeskExecutionMapping(state.binding)!
  );
  const childOutput = physicalScopedPath(
    'active/shared/runtime/front-desk-execution',
    charter.scope,
    state.binding.work_item_id + '.json'
  );
  const strictRecovery = readUndispatchedWorkItemEvidence({
    workItemId: state.binding.work_item_id,
    actionRef: state.original.action_ref,
    approvalRequestId: state.receipt.approval_request_id,
    binding: state.binding,
  });
  return {
    proofValid,
    workItem: item,
    preparationError,
    strictRecovery,
    childArtifactAbsent: absent(childArtifact),
    childOutputAbsent: absent(childOutput),
    childResults: readJsonLines<DotWorkResultRow>(
      dotStatePath(charter, DOT_WORK_RESULTS_FILE)
    ).filter((row) => row.work_item_id === state.binding.work_item_id).length,
    originalApprovalUnchanged:
      computeApprovalPayloadHash({
        value: loadApprovalRequest('autonomy', state.receipt.approval_request_id),
      }) === state.receipt.approval_hash,
  };
}
function run(mode: string) {
  if (mode === 'stale-lineage') return runStaleLineage();
  if (mode === 'facade-smoke') return runFacadeSmoke();
  if (mode === 'validate-root') return { isolated: true };
  if (mode === 'seed') return seed();
  if (mode === 'seed-revision') return seedRevision();
  const state = readJson(fixture) as {
    binding: FrontDeskExecutionRecoveryReceipt['binding'];
    original: DotActionRecord;
    receipt: FrontDeskExecutionRecoveryReceipt;
    approval: unknown;
    parent?: FrontDeskExecutionBinding;
    parentSha?: string;
    parentBody?: string;
  };
  const { binding, original, receipt } = state;
  const selector = {
    workItemId: binding.work_item_id,
    actionRef: original.action_ref,
    approvalRequestId: receipt.approval_request_id,
    binding,
  };
  if (mode === 'recover' || mode === 'crash') {
    withFrontDeskDispatchLock(binding, () =>
      withUndispatchedWorkItemEvidence(selector, () =>
        withFrontDeskExecutionRecovery(binding, (_request, terminate) => {
          terminate(receipt);
          if (mode === 'crash') {
            // The managed parent terminates this process while all fences remain held.
            process.stdout.write('CRASH_AFTER_TOMBSTONE\n');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
            throw new Error('crash fixture unexpectedly resumed');
          }
          declineRecoveredDotAction(original, receipt);
        })
      )
    );
  } else if (mode.startsWith('revision-')) {
    const parent = state.parent!;
    const newId =
      mode === 'revision-a'
        ? '00000000-0000-4000-8000-000000000003'
        : '00000000-0000-4000-8000-000000000004';
    reserveConversationTurn(
      viewer,
      frontDeskArtifactRevisionCommand('compact'),
      newId,
      Date.now(),
      undefined,
      {
        requestId: parent.request_id,
        revision: parent.revision,
        sha256: state.parentSha!,
        format: 'compact',
      },
      { requireDiagnosticAdmission: true }
    );
  } else if (mode === 'settle') {
    settleDotParkedActions(charter, { assertTenant: () => undefined });
  } else if (mode === 'ambiguous') {
    appendJsonLine(DOT_ACTION_LEDGER_PATH, { ...original, action_ref: 'alternate-linked-action' });
  } else if (mode === 'restore-actions') {
    safeWriteFile(
      DOT_ACTION_LEDGER_PATH,
      [
        original,
        {
          ...original,
          status: 'declined',
          reason: 'terminated_unstarted',
          recovery_receipt: receipt,
          at: receipt.terminated_at,
        },
      ]
        .map((row) => JSON.stringify(row) + '\n')
        .join('')
    );
  } else if (mode === 'pause') {
    transitionDotCharterStatus(charter.dot_id, 'paused', { actor: 'synthetic-test-fixture' });
  } else if (mode === 'activate') {
    transitionDotCharterStatus(charter.dot_id, 'active', { actor: 'synthetic-test-fixture' });
  } else if (mode === 'followup') {
    reserveConversationTurn(
      viewer,
      'Add a chart to ' + requestId,
      '00000000-0000-4000-8000-000000000002'
    );
    reserveConversationTurn(viewer, 'Cancel ' + requestId, '00000000-0000-4000-8000-000000000003');
  } else if (mode.startsWith('witness')) {
    withFrontDeskDispatchLock(binding, () => {
      const file = 'active/shared/runtime/dispatch-lock-witness.jsonl';
      appendJsonLine(file, { phase: 'begin', process: mode });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      appendJsonLine(file, { phase: 'end', process: mode });
    });
  } else if (mode === 'new') {
    reserveConversationTurn(
      viewer,
      FRONT_DESK_RECEIPT_COMMAND,
      '00000000-0000-4000-8000-000000000004',
      Date.now(),
      undefined,
      undefined,
      { requireDiagnosticAdmission: true }
    );
  }
  const request = readFrontDeskExecutionRecovery(binding);
  const transcript = readJson<{ version: number }>(conversationRef(viewer).path);
  return {
    request,
    oldAdmission: inspectFrontDeskExecution(binding, charter),
    requests: listConfiguredFrontDeskExecutions().map((entry) => ({
      binding: entry.binding,
      status: entry.request.status,
      admission: inspectFrontDeskExecution(entry.binding, charter).ok,
      actionCount: readDotActionLedgerStrict().filter(
        (row) => row.front_desk_execution?.request_id === entry.binding.request_id
      ).length,
      workItem: getWorkItem(entry.binding.work_item_id),
      artifactPath: frontDeskExecutionArtifactPath(
        entry.binding,
        getFrontDeskExecutionMapping(entry.binding)!
      ),
    })),
    parentArtifact: state.parent
      ? readFrontDeskConversationArtifact(viewer, {
          request_id: state.parent.request_id,
          revision: state.parent.revision,
          sha256: state.parentSha!,
        })
      : undefined,
    history: readConversationHistory(viewer, { readOnly: true }),
    actionRows: readDotActionLedgerStrict().filter((row) => row.action_ref === original.action_ref),
    workItem: getWorkItem(binding.work_item_id),
    work: readFrontDeskConversationWork(viewer),
    version: transcript.version,
    proofValid: hasVerifiedFirstJobDecision(
      loadApprovalRequest('autonomy', receipt.approval_request_id)!,
      charter,
      binding
    ),
    originalApprovalUnchanged:
      computeApprovalPayloadHash({
        value: loadApprovalRequest('autonomy', receipt.approval_request_id),
      }) === receipt.approval_hash,
    witness: mode.startsWith('witness')
      ? readJsonLines('active/shared/runtime/dispatch-lock-witness.jsonl')
      : undefined,
  };
}
// Never permit manual fixture initialization in the real repository or an
// arbitrary caller-selected root. This check precedes READY and every command.
const fixtureSourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const configuredFixtureRoot = getRegisteredEnvText('KYBERION_ROOT');
const fixtureId = /^[a-f0-9]{12}$/;
const fixtureRootParts = configuredFixtureRoot
  ? path
      .relative(path.join(fixtureSourceRoot, 'active/shared/tmp'), configuredFixtureRoot)
      .split(path.sep)
  : [];
if (
  !configuredFixtureRoot ||
  configuredFixtureRoot !== process.cwd() ||
  fixtureRootParts.length !== 2 ||
  !fixtureRootParts[0].startsWith('recovery-engine-') ||
  !fixtureId.test(fixtureRootParts[0].slice('recovery-engine-'.length)) ||
  !fixtureId.test(fixtureRootParts[1])
)
  throw new Error('isolated recovery-engine test root required');
if (
  ![
    'validate-root',
    'facade-smoke',
    'stale-lineage',
    'seed',
    'seed-revision',
    'recover',
    'crash',
    'revision-a',
    'revision-b',
    'settle',
    'ambiguous',
    'restore-actions',
    'pause',
    'activate',
    'followup',
    'witness-a',
    'witness-b',
    'new',
    'read',
    'proof-valid',
  ].includes(process.argv[2])
)
  throw new Error('unknown recovery-engine fixture command');
process.stdout.write('READY\n');
process.stdin.once('data', () => {
  try {
    const value = withExecutionContext('ecosystem_architect', () => run(process.argv[2]));
    process.stdout.write(JSON.stringify({ ok: true, value }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(error) }) + '\n');
    process.exitCode = 1;
  }
});
