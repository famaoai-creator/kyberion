/** Human-directed admission. Autonomous mandate shadow is never a permission to activate. */
import * as path from 'node:path';
import { nowIso } from '@agent/core/foundation';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import { withLock } from '@agent/core/lock-utils';
import { findMissionPath } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import {
  getWorkItem,
  updateWorkItem,
  claimWorkItem,
  releaseWorkItem,
  reapExpiredWorkLeases,
} from '@agent/core/workforce/work-coordination';
import {
  buildMissionAdmissionBrief,
  prepareMissionAdmissionBrief,
  readMissionAdmissionBrief,
  resolveDotMissionAdmission,
  resolveDotMissionAdmissionScope,
  withHumanMissionAdmissionApply,
} from '@agent/core/mission/mission-admission';
import { loadState } from '@agent/core/mission/mission-state';
import {
  listApprovalRequests,
  loadApprovalRequest,
  computeApprovalPayloadHash,
  computeApprovalPresentedDigest,
  claimApprovalApply,
  recordApprovalApplyResult,
  isApprovalRequestExpired,
  validateHumanFinalDecision,
  expireApprovalRequest,
  type ApprovalRequestRecord,
} from '@agent/core/governance/approval-store';
import { resolveAccountableHuman } from '@agent/core/organization/member-registry';
import { isOperationsHalted } from '@agent/core/governance/operations-halt';
import { openAlignmentApproval } from './mission-alignment-gate/alignment-approval.js';
import type { WorkItem } from '@agent/core/workforce/work-coordination-types';

export type AdmissionContinuationResult = {
  status: 'pending_approval' | 'approved' | 'completed' | 'held' | 'reconciliation_required';
  missionId?: string;
  requestId?: string;
  approvalCreated?: boolean;
  reason?: string;
};
type Dependencies = {
  prepare?: boolean;
  expectedVersion?: number;
  rootDir?: string;
  now?: () => Date;
  runController?: (args: string[]) => Promise<unknown>;
};
const ROLE = 'infrastructure_sentinel';
const ACTOR = 'mission_controller';
const PIN = 'mission_alignment_preparation';

function proposal(item: WorkItem, deps: Dependencies) {
  const admission = resolveDotMissionAdmission(item, deps);
  const scope = resolveDotMissionAdmissionScope(item, deps);
  const missionId = item.metadata!.mission_id as string;
  const brief = buildMissionAdmissionBrief(item, admission, missionId);
  const payloadHash = computeApprovalPayloadHash(brief);
  const identity = {
    action: 'human_mission_alignment',
    itemId: item.item_id,
    missionId,
    actionRef: item.metadata!.action_ref,
    scope,
  };
  const effectBinding = 'mission-admission:' + computeApprovalPayloadHash(identity);
  const fingerprint = computeApprovalPayloadHash({
    ...identity,
    brief,
    context: item.context,
  });
  return { item, scope, missionId, brief, payloadHash, effectBinding, fingerprint };
}
type Proposal = ReturnType<typeof proposal>;

function missionRead<T>(p: Proposal, fn: () => T): T {
  return withExecutionContext(ACTOR, fn, undefined, p.scope.tenant_slug, p.scope.organization_id);
}
function receipt(p: Proposal, deps: Dependencies): 'planned' | 'active' | 'missing' | 'conflict' {
  return missionRead(p, () => scopedReceipt(p, deps));
}
function scopedReceipt(
  p: Proposal,
  deps: Dependencies
): 'planned' | 'active' | 'missing' | 'conflict' {
  const state = loadState(p.missionId, deps);
  const dir = findMissionPath(p.missionId);
  if (!state || !dir) return 'missing';
  if (
    state.tenant_slug !== p.scope.tenant_slug ||
    state.organization_id !== p.scope.organization_id ||
    state.relationships?.project?.project_id !== p.scope.project_id ||
    state.tier !== 'confidential'
  )
    return 'conflict';
  const file = path.join(dir, 'evidence', 'mission-brief.json');
  if (!safeExistsSync(file)) return 'missing';
  if (computeApprovalPayloadHash(readMissionAdmissionBrief(file)) !== p.payloadHash)
    return 'conflict';
  return state.status === 'active' || state.status === 'planned' ? state.status : 'conflict';
}

function matchingApproval(p: Proposal): ApprovalRequestRecord | undefined {
  const rows = listApprovalRequests({
    storageChannels: ['brief'],
    kind: 'mission_gate',
  }).filter((row) => row.source?.missionId === p.missionId);
  // A previously created record, including an unbound legacy record, must not be silently replaced.
  if (rows.length > 1)
    throw new Error('multiple mission alignment decisions require reconciliation');
  return rows[0];
}
function assertBound(record: ApprovalRequestRecord, p: Proposal): void {
  if (
    record.correlationId !== 'mission-alignment-' + p.missionId ||
    record.source?.taskId !== p.item.item_id ||
    record.source?.missionId !== p.missionId ||
    record.accountability?.finalDecision !== 'human_only' ||
    record.accountability.payloadHash !== p.payloadHash ||
    record.accountability.effectBinding !== p.effectBinding ||
    record.scope?.tenant_slug !== p.scope.tenant_slug ||
    record.scope.organization_id !== p.scope.organization_id ||
    record.scope.project_id !== p.scope.project_id ||
    record.scope.mission_id !== p.missionId ||
    record.scope.task_id !== p.item.item_id ||
    record.scope.tier !== 'confidential'
  )
    throw new Error('mission admission approval binding changed');
}

/**
 * Same-work planned -> human alignment -> activation. Durable pins/claims live in
 * the existing WorkItem and approval record; a lease timeout never proves no effect.
 */
export async function continueHumanMissionAdmission(
  itemId: string,
  deps: Dependencies = {}
): Promise<AdmissionContinuationResult> {
  // Claim/release facades use the current coordination root; never mix an alternate read root with live writes.
  if (deps.rootDir)
    return { status: 'held', reason: 'alternate admission roots are not supported' };
  return withExecutionContextAsync(ROLE, () =>
    withLock('human-mission-admission:' + itemId, async () => {
      if (isOperationsHalted()) return { status: 'held', reason: 'operations halted' };
      const original = getWorkItem(itemId, deps);
      if (!original || !['blocked', 'ready', 'in_progress', 'done'].includes(original.status))
        return { status: 'held', reason: 'work item is missing or cancelled' };
      if (deps.expectedVersion !== undefined && original.version !== deps.expectedVersion)
        return { status: 'held', reason: 'work item changed since the request' };
      let p = proposal(original, deps);
      const result = (
        status: AdmissionContinuationResult['status'],
        reason?: string,
        requestId?: string
      ): AdmissionContinuationResult => ({
        status,
        missionId: p.missionId,
        ...(reason ? { reason } : {}),
        ...(requestId ? { requestId } : {}),
      });
      const refresh = () => {
        const current = getWorkItem(itemId, deps);
        if (!current || !['blocked', 'ready', 'in_progress', 'done'].includes(current.status))
          throw new Error('mission admission work cancelled');
        const next = proposal(current, deps);
        if (next.fingerprint !== p.fingerprint || isOperationsHalted())
          throw new Error('mission admission changed or halted');
        p = next;
      };
      const run = async (verb: 'create' | 'start') => {
        refresh();
        const invoke = deps.runController ?? (await import('./mission_controller.js')).main;
        refresh();
        const args = [
          verb,
          p.missionId,
          '--tier',
          'confidential',
          '--persona',
          'worker',
          '--tenant',
          p.scope.tenant_slug,
          '--tenant-slug',
          p.scope.tenant_slug,
          '--goal',
          p.item.description,
          ...(p.scope.organization_id ? ['--organization-id', p.scope.organization_id] : []),
          ...(p.scope.project_id ? ['--project-id', p.scope.project_id] : []),
          ...(verb === 'start' ? ['--admission-work-item', itemId] : []),
        ];
        await withExecutionContextAsync(
          ACTOR,
          () => invoke(args),
          undefined,
          p.scope.tenant_slug,
          p.scope.organization_id
        );
      };
      try {
        const pin = p.item.metadata?.[PIN] as { fingerprint?: string } | undefined;
        if (pin && pin.fingerprint !== p.fingerprint)
          return result('held', 'approved proposal changed; explicit revision required');
        if (!pin && !deps.prepare)
          return result('held', 'explicit work-item alignment request required');
        if (!pin) {
          if (
            p.item.status === 'done' ||
            p.item.lease_id ||
            missionRead(p, () => loadState(p.missionId, deps) || findMissionPath(p.missionId)) ||
            matchingApproval(p)
          )
            return result('reconciliation_required', 'unowned existing admission evidence');
          updateWorkItem({
            itemId,
            expectedVersion: p.item.version,
            rootDir: deps.rootDir,
            status: 'blocked',
            metadata: {
              ...p.item.metadata,
              [PIN]: { fingerprint: p.fingerprint, sourceVersion: p.item.version },
            },
          });
          // A crash after this pin never repeats create, including a partial controller failure.
          await run('create');
          refresh();
          await withExecutionContextAsync(
            ACTOR,
            async () => prepareMissionAdmissionBrief(p.missionId, itemId, deps),
            undefined,
            p.scope.tenant_slug,
            p.scope.organization_id
          );
        }
        const stateReceipt = receipt(p, deps);
        if (stateReceipt === 'missing' || stateReceipt === 'conflict')
          return result('reconciliation_required', 'partial or conflicting mission preparation');
        let approval = matchingApproval(p);
        let approvalCreated = false;
        if (!approval && !deps.prepare)
          return result('held', 'bound human alignment request missing');
        if (!approval) {
          if (stateReceipt !== 'planned' || p.item.status === 'done')
            return result('reconciliation_required', 'activation lacks bound decision');
          const opened = missionRead(p, () =>
            openAlignmentApproval(p.missionId, {
              requestedBy: ACTOR,
              binding: {
                source: {
                  missionId: p.missionId,
                  taskId: itemId,
                  agentId: String(p.item.metadata?.dot_id),
                },
                scope: {
                  tier: 'confidential',
                  ...p.scope,
                  tenant_slug: p.scope.tenant_slug,
                  mission_id: p.missionId,
                  task_id: itemId,
                  work_shape: 'mission',
                },
                effectBinding: p.effectBinding,
                expiresAt: new Date(
                  (deps.now?.() ?? new Date()).getTime() + 72 * 3600_000
                ).toISOString(),
              },
            })
          );
          if (!opened.requestId)
            throw new Error(opened.reason || 'alignment approval not persisted');
          approval = loadApprovalRequest('brief', opened.requestId) ?? undefined;
          approvalCreated = opened.created;
        }
        if (!approval) throw new Error('alignment approval missing');
        assertBound(approval, p);
        const requestId = approval.id;
        if (approval.applyResult?.result === 'success' || approval.applyClaim) {
          // Reconcile original application only. Never acquire another approval claim or re-run start.
          if (stateReceipt !== 'active')
            return result(
              'reconciliation_required',
              'claimed activation outcome unknown',
              requestId
            );
          if (approval.applyResult && approval.applyResult.result !== 'success')
            return result('reconciliation_required', 'failed application needs review', requestId);
          if (!approval.applyResult)
            recordApprovalApplyResult(ROLE, {
              channel: 'brief',
              requestId,
              claimId: approval.applyClaim!.claimId,
              applyResult: {
                result: 'success',
                appliedBy: ACTOR,
                appliedAt: nowIso(),
                auditRef: 'mission:' + p.missionId,
              },
            });
          settleWork(p, deps, requestId);
          return result('completed', undefined, requestId);
        }
        if (approval.revocation || !['pending', 'approved'].includes(approval.status))
          return result(
            'held',
            'approval ' + (approval.revocation ? 'revoked' : approval.status),
            requestId
          );
        if (isApprovalRequestExpired(approval, (deps.now?.() ?? new Date()).getTime())) {
          if (approval.status === 'pending')
            expireApprovalRequest(ROLE, { channel: 'brief', requestId });
          return result('held', 'approval expired', requestId);
        }
        if (approval.status === 'pending')
          return { ...result('pending_approval', undefined, requestId), approvalCreated };
        if (stateReceipt !== 'planned')
          return result('reconciliation_required', 'unclaimed activation', requestId);
        if (deps.prepare)
          return result(
            'approved',
            'alignment approved; awaiting governed continuation',
            requestId
          );
        refresh();
        assertCurrentHumanDecision(approval, p);
        const claimed = claimWorkItem({
          itemId,
          actorPeerId: ACTOR,
          purpose: 'human-approved mission activation',
          expectedVersion: p.item.version,
          requireNewLease: true,
          idempotencyKey: p.effectBinding,
          ttlMs: 300_000,
          metadata: { approval_request_id: requestId, effect_binding: p.effectBinding },
        });
        let applyClaimed = false;
        try {
          const currentApproval = loadApprovalRequest('brief', requestId);
          if (!currentApproval) throw new Error('approval missing before activation');
          refresh();
          assertBound(currentApproval, p);
          assertCurrentHumanDecision(currentApproval, p);
          const applying = claimApprovalApply(ROLE, {
            channel: 'brief',
            requestId,
            appliedBy: ACTOR,
            expectedRecordHash: computeApprovalPayloadHash({ record: currentApproval }),
          });
          applyClaimed = true;
          await withHumanMissionAdmissionApply(
            {
              workItemId: itemId,
              requestId,
              claimId: applying.applyClaim.claimId,
              leaseId: claimed.lease.lease_id,
              attemptId: claimed.item.current_attempt_id!,
            },
            () => run('start')
          );
          refresh();
          if (receipt(p, deps) !== 'active') throw new Error('activation has no exact receipt');
          const applied = loadApprovalRequest('brief', requestId)!;
          recordApprovalApplyResult(ROLE, {
            channel: 'brief',
            requestId,
            claimId: applied.applyClaim!.claimId,
            applyResult: {
              result: 'success',
              appliedAt: nowIso(),
              appliedBy: ACTOR,
              auditRef: 'mission:' + p.missionId,
            },
          });
          settleWork(p, deps, requestId);
          return result('completed', undefined, requestId);
        } catch (error) {
          if (!applyClaimed)
            releaseWorkItem({
              itemId,
              leaseId: claimed.lease.lease_id,
              actorPeerId: ACTOR,
              nextStatus: 'blocked',
              effectDisposition: 'pre_effect',
              summary: 'activation refused before apply claim',
            });
          return result('reconciliation_required', String(error), requestId);
        }
      } catch (error) {
        return result(
          'reconciliation_required',
          error instanceof Error ? error.message : String(error)
        );
      }
    })
  );
}

function settleWork(p: Proposal, deps: Dependencies, requestId: string): void {
  const item = getWorkItem(p.item.item_id, deps);
  if (!item || item.status === 'done') return;
  const attempt = item.attempts?.find((row) => row.run_id === item.current_attempt_id);
  if (
    !attempt ||
    attempt.metadata?.approval_request_id !== requestId ||
    attempt.metadata?.effect_binding !== p.effectBinding
  )
    throw new Error('activation ownership differs from approved attempt');
  if (item.lease_id && item.claimed_by_peer_id === ACTOR) {
    try {
      releaseWorkItem({
        itemId: item.item_id,
        leaseId: item.lease_id,
        actorPeerId: ACTOR,
        nextStatus: 'done',
        effectDisposition: 'completed',
        summary: 'verified human-directed mission admission: ' + p.missionId,
      });
      return;
    } catch {
      // The reaper owns expired-lease settlement; exact durable completion is its evidence.
    }
  }
  reapExpiredWorkLeases({
    itemFilter: (row) => row.item_id === item.item_id,
    completedEvidence: (row) =>
      proposal(row, deps).fingerprint === p.fingerprint && receipt(p, deps) === 'active',
  });
  if (getWorkItem(item.item_id, deps)?.status !== 'done')
    throw new Error('activation verified; work ownership still requires reconciliation');
}

function assertCurrentHumanDecision(currentApproval: ApprovalRequestRecord, p: Proposal): void {
  if (
    !currentApproval.decidedBy?.trim() ||
    currentApproval.decidedByIdentitySource === 'caller_supplied' ||
    currentApproval.assuranceShortfall ||
    currentApproval.decidedInAgentSession ||
    !currentApproval.decidedAt ||
    !Number.isFinite(Date.parse(currentApproval.decidedAt)) ||
    !currentApproval.verifiedPresentedDigest ||
    currentApproval.verifiedPresentedDigest !== computeApprovalPresentedDigest(currentApproval)
  )
    throw new Error('human admission requires a verified decider');
  validateHumanFinalDecision({
    accountability: currentApproval.accountability,
    decidedByType: currentApproval.decidedByType,
    authenticated: currentApproval.authenticated,
    authMethod: currentApproval.decidedAuthMethod,
    phase: 'decision',
    mode: 'enforce',
    channel: currentApproval.channel,
    payloadHash: p.payloadHash,
    effectBinding: p.effectBinding,
  });
  const member = withExecutionContext('sovereign_concierge', () =>
    resolveAccountableHuman(currentApproval.decidedBy!)
  );
  const membership = member?.memberships.find((row) => row.tenant_slug === p.scope.tenant_slug);
  if (
    member?.status !== 'active' ||
    !membership ||
    !['owner', 'approver'].includes(membership.role)
  )
    throw new Error('human admission requires current tenant approval authority');
}
