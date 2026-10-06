import { nowIso } from '../foundation/time.js';
/** Explicit termination of fixed diagnostics with retained, strict negative execution evidence. */
import { withExecutionContext } from '../authority.js';
import { findDotCharter } from '../dot/dot-charter.js';
import {
  readDotActionLedgerStrict,
  dotActionRecordHash,
  declineRecoveredDotAction,
  dotProposalHash,
} from '../dot/dot-dispatch.js';
import {
  readUndispatchedWorkItemEvidence,
  withUndispatchedWorkItemEvidence,
} from '../workforce/work-coordination.js';
import { assertBuiltinOnlyWorkerEventStream } from '../workforce/worker-event-stream.js';
import { loadApprovalRequest, computeApprovalPayloadHash } from '../governance/approval-store.js';
import {
  authenticateFirstJobBrowser,
  resolveFirstJobOwnerViewer,
  FirstJobApprovalError,
} from './first-job-approval.js';
import { firstJobApprovalEffect, hasVerifiedFirstJobDecision } from './first-job-approval-proof.js';
import { withFrontDeskDispatchLock } from './front-desk-dispatch-lock.js';
import {
  conversationRef,
  listConfiguredFrontDeskExecutions,
  inspectFrontDeskExecution,
  readFrontDeskExecutionRecovery,
  withFrontDeskExecutionRecovery,
  type FrontDeskExecutionRecoveryReceipt,
} from './front-desk-conversation-store.js';
import { frontDeskExecutionViewerMatches } from './front-desk-execution-contract.js';
import {
  assertFrontDeskRecoveryOutputsAbsent,
  withFrontDeskRecoveryResultLock,
} from './front-desk-recovery-evidence.js';
import { frontDeskBindingsEqual, frontDeskExecutionProposal } from './front-desk-execution.js';
import {
  parseFirstJobRecoveryRequest,
  type FirstJobReadRequest,
  type FirstJobRecoveryRequest,
} from './first-job-contract.js';
import type { SurfaceViewerScope } from './surface-mutation-guard.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = (value: unknown) => computeApprovalPayloadHash({ value });
function reject(): never {
  throw new FirstJobApprovalError(409, 'first_job_recovery_unavailable');
}
type Auth = ReturnType<typeof authenticateFirstJobBrowser>;
export interface FirstJobRecoveryView {
  request_id: string;
  approval_request_id: string;
  session_id: string;
  status: 'eligible' | 'terminated_unstarted';
  display_digest: string;
  revision: number;
  tenant: string;
}
function inspected(viewer: SurfaceViewerScope, auth: Auth, requestId: string) {
  assertBuiltinOnlyWorkerEventStream();
  const entries = listConfiguredFrontDeskExecutions((mapping) =>
    frontDeskExecutionViewerMatches(viewer, mapping)
  ).filter((entry) => entry.binding.request_id === requestId);
  if (entries.length !== 1) reject();
  const { binding, mapping } = entries[0];
  const request = readFrontDeskExecutionRecovery(binding);
  if (
    !request ||
    !frontDeskBindingsEqual(binding, request.binding) ||
    request.sessionId !== conversationRef(viewer).sessionId ||
    request.revision !== binding.revision ||
    request.requestDigest !== binding.request_digest ||
    !['pending', 'terminated_unstarted'].includes(request.status)
  )
    reject();
  const charter = findDotCharter(mapping.dotId)?.charter;
  if (!charter) reject();
  const effect = firstJobApprovalEffect(charter, binding);
  if (effect.ownerMemberId !== auth.principal.memberId) reject();
  if (request.status === 'pending' && !inspectFrontDeskExecution(binding, charter).ok) reject();
  const rows = readDotActionLedgerStrict();
  const linked = rows.filter(
    (row) =>
      row.front_desk_execution?.request_id === requestId ||
      row.front_desk_execution?.work_item_id === binding.work_item_id ||
      row.work_item_id === binding.work_item_id
  );
  const refs = new Set(linked.map((row) => row.action_ref));
  if (refs.size !== 1) reject();
  const history = rows.filter((row) => row.action_ref === linked[0].action_ref);
  const action = history.at(-1)!;
  const approvalId = action.request_id;
  if (
    !approvalId ||
    !UUID.test(approvalId) ||
    rows.some((row) => row.request_id === approvalId && row.action_ref !== action.action_ref) ||
    history.some(
      (row) =>
        row.status === 'dispatched' ||
        row.work_item_id ||
        row.dot_id !== charter.dot_id ||
        !frontDeskBindingsEqual(binding, row.front_desk_execution)
    )
  )
    reject();
  const original = history.find((row) => row.status === 'parked');
  const expected = frontDeskExecutionProposal(binding);
  if (
    !original ||
    !['parked', 'declined'].includes(action.status) ||
    original.decision !== 'approve' ||
    original.actor_id !== 'dot:' + charter.dot_id ||
    original.action_id !== expected.action_id ||
    original.work_shape !== expected.work_shape ||
    original.pipeline_ref !== expected.pipeline_ref ||
    original.target !== expected.target ||
    original.intent !== expected.intent ||
    original.handoff_to ||
    original.proposal_hash !== dotProposalHash(charter.dot_id, expected) ||
    history.some(
      (row) => row.status === 'parked' && dotActionRecordHash(row) !== dotActionRecordHash(original)
    )
  )
    reject();
  const approval = loadApprovalRequest('autonomy', approvalId);
  if (
    !approval ||
    !['approved', 'applied'].includes(approval.status) ||
    approval.storageChannel !== 'autonomy' ||
    approval.kind !== 'channel-approval' ||
    approval.requestedBy !== 'dot:' + charter.dot_id ||
    approval.accountability?.finalDecision !== 'human_only' ||
    approval.accountability.payloadHash !== effect.payloadHash ||
    approval.accountability.effectBinding !== effect.effectBinding ||
    hash(approval.scope) !== hash(effect.effect.scope) ||
    approval.target ||
    approval.steering ||
    approval.workflow ||
    approval.veto ||
    (approval.decidedBy && approval.decidedBy !== auth.principal.actor.id) ||
    (request.status === 'pending' && hasVerifiedFirstJobDecision(approval, charter, binding))
  )
    reject();
  const approvalHash = hash(approval);
  const actionHash = dotActionRecordHash(original);
  const receipt = request.recoveryReceipt;
  if (request.status === 'terminated_unstarted') {
    if (
      !receipt ||
      receipt.approval_request_id !== approvalId ||
      receipt.approval_hash !== approvalHash ||
      receipt.action_hash !== actionHash ||
      receipt.action_ref !== action.action_ref ||
      receipt.member_id !== auth.principal.memberId ||
      receipt.actor_id !== auth.principal.actor.id ||
      !frontDeskBindingsEqual(binding, receipt.binding)
    )
      reject();
    if (action.status === 'declined' && hash(action.recovery_receipt) !== hash(receipt)) reject();
  } else if (receipt || action.status !== 'parked') reject();
  const proofInput = {
    workItemId: binding.work_item_id,
    actionRef: action.action_ref,
    approvalRequestId: approvalId,
    binding,
  };
  if (!readUndispatchedWorkItemEvidence(proofInput).ok) reject();
  assertFrontDeskRecoveryOutputsAbsent(charter, binding, original, mapping);
  const displayDigest = hash({
    operation: 'terminate_unstarted',
    binding,
    approval_hash: approvalHash,
    action_hash: actionHash,
    effect,
    charter,
    actor: auth.principal.actor.id,
    sid: auth.session.sid,
    exp: auth.session.exp,
  });
  return {
    charter,
    binding,
    original,
    action,
    receipt,
    proofInput,
    approvalHash,
    actionHash,
    view: {
      request_id: requestId,
      approval_request_id: approvalId,
      session_id: conversationRef(viewer).sessionId,
      status:
        receipt && action.status === 'declined'
          ? ('terminated_unstarted' as const)
          : ('eligible' as const),
      display_digest: displayDigest,
      revision: binding.revision,
      tenant: viewer.tenantSlugs[0],
    },
  };
}
/** Advisory only. No locks, initialization, mutation, path disclosure or inferred identity. */
export function readFirstJobRecoveries(
  authenticated: SurfaceViewerScope,
  token: string,
  input: FirstJobReadRequest = {}
): FirstJobRecoveryView[] {
  try {
    const auth = authenticateFirstJobBrowser(token);
    const viewer = resolveFirstJobOwnerViewer(authenticated, auth.principal.memberId!, input);
    const ids = listConfiguredFrontDeskExecutions((mapping) =>
      frontDeskExecutionViewerMatches(viewer, mapping)
    ).map((entry) => entry.binding.request_id);
    return [...new Set(ids)].flatMap((id) => {
      try {
        return [inspected(viewer, auth, id).view];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
/** Only a current, explicitly submitted browser decision can finish this same terminal transition. */
export function terminateFirstJobRequest(
  authenticated: SurfaceViewerScope,
  token: string,
  requestId: string,
  input: FirstJobRecoveryRequest
) {
  if (!UUID.test(requestId) || !parseFirstJobRecoveryRequest(input))
    throw new FirstJobApprovalError(400, 'first_job_invalid_request');
  const initialAuth = authenticateFirstJobBrowser(token);
  const initialViewer = resolveFirstJobOwnerViewer(
    authenticated,
    initialAuth.principal.memberId!,
    input
  );
  const initial = inspected(initialViewer, initialAuth, requestId);
  return withExecutionContext('infrastructure_sentinel', () =>
    withFrontDeskDispatchLock(initial.binding, () =>
      withUndispatchedWorkItemEvidence(initial.proofInput, () =>
        withFrontDeskExecutionRecovery(initial.binding, (_request, terminate) =>
          withFrontDeskRecoveryResultLock(initial.charter, () => {
            const auth = authenticateFirstJobBrowser(token);
            const viewer = resolveFirstJobOwnerViewer(
              authenticated,
              auth.principal.memberId!,
              input
            );
            const checked = inspected(viewer, auth, requestId);
            if (checked.view.display_digest !== input.display_digest) reject();
            if (checked.view.status === 'terminated_unstarted')
              return {
                ok: true as const,
                request_id: requestId,
                status: 'terminated_unstarted' as const,
              };
            const receipt: FrontDeskExecutionRecoveryReceipt = checked.receipt ?? {
              version: 1,
              binding: checked.binding,
              action_ref: checked.original.action_ref,
              approval_request_id: checked.view.approval_request_id,
              approval_hash: checked.approvalHash,
              action_hash: checked.actionHash,
              display_digest: checked.view.display_digest,
              actor_id: auth.principal.actor.id,
              member_id: auth.principal.memberId!,
              browser_session_id: auth.session.sid,
              terminated_at: nowIso(),
              reason: 'approval_verification_failed',
            };
            // Evidence scans can take time. Expiry/revocation during them cannot authorize a write.
            const finalAuth = authenticateFirstJobBrowser(token);
            resolveFirstJobOwnerViewer(authenticated, finalAuth.principal.memberId!, input);
            if (
              finalAuth.principal.actor.id !== auth.principal.actor.id ||
              finalAuth.session.sid !== auth.session.sid
            )
              reject();
            terminate(receipt);
            declineRecoveredDotAction(checked.original, receipt);
            const readback = inspected(viewer, auth, requestId);
            if (readback.view.status !== 'terminated_unstarted')
              throw new Error('terminal_readback_failed');
            return {
              ok: true as const,
              request_id: requestId,
              status: 'terminated_unstarted' as const,
            };
          })
        )
      )
    )
  );
}
