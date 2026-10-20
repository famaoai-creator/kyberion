/** Internal Dot -> mission admission. No business effect permission is issued. */
import * as path from 'node:path';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { safeExistsSync, safeMkdir, safeWriteFile } from '../secure-io.js';
import { pathResolver, findMissionPath } from '../path-resolver.js';
import { findDotCharter } from '../dot/dot-charter.js';
import { assertDotAccountabilityCharter } from '../dot/dot-authority.js';
import { readDotActionLedgerStrict } from '../dot/dot-action-ledger.js';
import { dotAdmissionMissionId } from '../dot/dot-admission-identity.js';
import { getWorkItem, claimWorkItem, releaseWorkItem } from '../workforce/work-coordination.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import { normalizeWorkItemContext } from '../workforce/work-coordination-identity.js';
import {
  evaluateMissionStartMandate,
  parseMissionAdmissionRequest,
  type MissionAdmissionRequest,
} from '../governance/mandate-shadow.js';
import { computeApprovalPayloadHash } from '../governance/approval-presentation.js';
import { approvalUsabilityRefusal } from '../governance/approval-separation-of-duties.js';
import { listApprovalRequests, loadApprovalRequest } from '../governance/approval-store-reader.js';
import { validateHumanFinalDecision } from '../governance/approval-human-decision.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import {
  recordAutonomyExecution,
  recordAutonomyOutcome,
} from '../governance/autonomy-action-state.js';
import { loadState } from './mission-state.js';

type Deps = { rootDir?: string; now?: () => Date };
export function assertMissionAdmissionActivation(
  missionId: string,
  workItemId: string,
  tenantSlug: string | undefined,
  deps: Deps & { organizationId?: string; projectId?: string } = {}
): void {
  const item = getWorkItem(workItemId, deps);
  const scope = item ? resolveDotMissionAdmissionScope(item, deps) : undefined;
  if (
    !item ||
    item.metadata?.mission_id !== missionId ||
    item.context?.tenant_slug !== tenantSlug ||
    item.context?.organization_id !== deps.organizationId ||
    scope?.project_id !== deps.projectId
  )
    throw new Error('mission admission identity/scope mismatch');
  resolveDotMissionAdmission(item, deps);
}
export function resolveDotMissionAdmission(
  item: WorkItem,
  deps: Deps = {}
): MissionAdmissionRequest {
  return verifiedDotMissionAdmission(item, deps).admission;
}

/** Actual declared scope, after current charter and immutable admission proof checks. */
export function resolveDotMissionAdmissionScope(item: WorkItem, deps: Deps = {}) {
  return verifiedDotMissionAdmission(item, deps).scope;
}

function verifiedDotMissionAdmission(item: WorkItem, deps: Deps) {
  const admission = parseMissionAdmissionRequest(item.metadata?.mission_admission);
  const tenant = item.context?.tenant_slug;
  const dotId = item.metadata?.dot_id;
  const actionRef = item.metadata?.action_ref;
  if (
    !admission ||
    !tenant ||
    typeof dotId !== 'string' ||
    typeof actionRef !== 'string' ||
    item.metadata?.admission_only !== true ||
    item.metadata?.requested_work_shape !== 'mission' ||
    item.metadata?.mission_id !== dotAdmissionMissionId(actionRef)
  )
    throw new Error('unbound mission intake');
  const dot = findDotCharter(dotId, deps.rootDir)?.charter;
  // WorkItem creation canonicalizes an omitted project to its default bucket.
  // Compare against the same canonical scope, retaining explicit project bindings.
  const dotContext = dot ? normalizeWorkItemContext(dot.scope) : undefined;
  if (
    !dot ||
    dot.status !== 'active' ||
    dot.scope.tenant_slug !== tenant ||
    dot.scope.organization_id !== item.context?.organization_id ||
    dotContext?.project_id !== item.context?.project_id ||
    !dot.authority.allowed_work_shapes?.includes('mission') ||
    !dot.authority.mission_mandate_refs?.includes(admission.mandate_ref)
  )
    throw new Error('current Dot admission authority missing');
  assertDotAccountabilityCharter(dot, deps);
  const record = readDotActionLedgerStrict(deps)
    .filter((row) => row.action_ref === actionRef)
    .pop();
  if (
    !record ||
    record.status !== 'dispatched' ||
    record.work_item_id !== item.item_id ||
    record.dot_id !== dotId ||
    !record.admission_only ||
    computeApprovalPayloadHash(record.mission_admission as unknown as Record<string, unknown>) !==
      computeApprovalPayloadHash(admission as unknown as Record<string, unknown>)
  )
    throw new Error('mission intake differs from admitted action');
  if (
    !evaluateMissionStartMandate(
      { tenant_slug: tenant, mandate_id: admission.mandate_ref, facts: admission.mandate_facts },
      { now: deps.now?.() }
    ).covered
  )
    throw new Error('mission mandate no longer covers intake');
  return {
    admission,
    scope: {
      tenant_slug: tenant,
      ...(dot.scope.organization_id ? { organization_id: dot.scope.organization_id } : {}),
      ...(dot.scope.project_id ? { project_id: dot.scope.project_id } : {}),
    },
  };
}

type AdmissionBrief = {
  missionId: string;
  title: string;
  intent: string;
  missionAdmission: MissionAdmissionRequest;
  source: { kind: string; ref: string; tenantSlug: string };
  [key: string]: unknown;
};
function readBrief(file: string): AdmissionBrief {
  return defineCatalog<AdmissionBrief>({
    id: 'mission-admission-brief',
    path: file,
    schema: pathResolver.knowledge('product/schemas/mission-brief.schema.json'),
  }).load();
}

/** Called only by the governed controller after activation; never edits mission state. */
export function authorMissionAdmissionBrief(
  missionId: string,
  workItemId: string,
  deps: Deps = {}
): void {
  const item = getWorkItem(workItemId, deps);
  if (!item || item.metadata?.mission_id !== missionId)
    throw new Error('mission intake identity mismatch');
  const { admission, scope } = verifiedDotMissionAdmission(item, deps);
  const state = loadState(missionId, deps);
  const missionDir = findMissionPath(missionId);
  if (
    !state ||
    state.status !== 'active' ||
    state.tenant_slug !== item.context?.tenant_slug ||
    state.organization_id !== item.context?.organization_id ||
    state.relationships?.project?.project_id !== scope.project_id ||
    !missionDir
  )
    throw new Error('mission activation receipt missing');
  // A direct human kickoff does not come through the watchdog's claim. Claim
  // and settle the same origin via the facade after verifying activation.
  const claimed =
    !item.lease_id && item.status !== 'done'
      ? claimWorkItem({
          itemId: item.item_id,
          actorPeerId: 'mission_controller',
          purpose: 'internal mission admission',
          requireNewLease: true,
          expectedVersion: item.version,
          idempotencyKey: `mission-admission:${missionId}`,
        })
      : undefined;
  try {
    withLockSync(`mission-admission-brief:${missionDir}`, () => {
      const file = path.join(missionDir, 'evidence', 'mission-brief.json');
      if (safeExistsSync(file)) {
        const existing = readBrief(file);
        if (
          existing.source?.ref !== item.item_id ||
          computeApprovalPayloadHash(
            existing.missionAdmission as unknown as Record<string, unknown>
          ) !== computeApprovalPayloadHash(admission as unknown as Record<string, unknown>)
        )
          throw new Error('existing mission brief has different admission; human review required');
        return;
      }
      const brief: AdmissionBrief = {
        missionId,
        title: item.title,
        intent: item.description,
        tier: state.tier,
        scope: { in: admission.mandate_facts.paths },
        gate: { riskLevel: admission.mandate_facts.risk_level, approvalRequired: true },
        estimate: {
          cost: `${admission.mandate_facts.estimated_cost} ${admission.mandate_facts.currency}`,
        },
        missionAdmission: admission,
        source: { kind: 'dot_work_item', ref: item.item_id, tenantSlug: state.tenant_slug! },
      };
      safeMkdir(path.dirname(file), { recursive: true });
      safeWriteFile(file, JSON.stringify(brief, null, 2));
    });
    if (claimed)
      releaseWorkItem({
        itemId: item.item_id,
        leaseId: claimed.lease.lease_id,
        actorPeerId: 'mission_controller',
        nextStatus: 'done',
        effectDisposition: 'completed',
        summary: `internal mission admitted: ${missionId}`,
      });
  } catch (error) {
    if (claimed)
      releaseWorkItem({
        itemId: item.item_id,
        leaseId: claimed.lease.lease_id,
        actorPeerId: 'mission_controller',
        nextStatus: 'blocked',
        summary: 'internal admission brief held; inspect lifecycle evidence',
      });
    throw error;
  }
  // Approval-first resume also needs a receipt after the real activation;
  // the earlier store mutation may legitimately have observed a draft state.
  const approved = listApprovalRequests({ storageChannels: ['brief'], kind: 'mission_gate' }).find(
    (record) =>
      record.source?.missionId === missionId &&
      record.correlationId === `mission-alignment-${missionId}`
  );
  if (approved) recordVerifiedMissionAdmissionApproval(approved, deps);
}

/** Mutation hook after a human decides alignment; assessors remain read-only. */
export function recordVerifiedMissionAdmissionApproval(
  record: ApprovalRequestRecord,
  deps: Deps = {}
): void {
  // Never trust a constructed object or a stale pre-revocation snapshot.
  if (!record.id || !(record.storageChannel || record.channel)) return;
  const current = loadApprovalRequest(record.storageChannel || record.channel, record.id);
  if (!current) return;
  record = current;
  const missionId = record.source?.missionId;
  if (
    !missionId ||
    record.status !== 'approved' ||
    record.decidedByType !== 'human' ||
    !record.decidedBy ||
    record.correlationId !== `mission-alignment-${missionId}` ||
    record.accountability?.finalDecision !== 'human_only' ||
    approvalUsabilityRefusal(record, 'mission_admission_learning')
  )
    return;
  try {
    validateHumanFinalDecision({
      accountability: record.accountability,
      decidedByType: record.decidedByType,
      authenticated: record.authenticated,
      authMethod: record.decidedAuthMethod,
      phase: 'recheck',
      mode: 'enforce',
      payloadHash: record.accountability.payloadHash,
      effectBinding: record.accountability.effectBinding,
    });
  } catch {
    return;
  }
  const state = loadState(missionId, deps);
  const missionDir = findMissionPath(missionId);
  if (!state || state.status !== 'active' || !state.tenant_slug || !missionDir) return;
  const brief = readBrief(path.join(missionDir, 'evidence', 'mission-brief.json'));
  if (
    record.accountability.payloadHash !== computeApprovalPayloadHash(brief) ||
    !brief.missionAdmission ||
    brief.source?.kind !== 'dot_work_item' ||
    brief.source.tenantSlug !== state.tenant_slug
  )
    return;
  const item = getWorkItem(brief.source.ref, deps);
  if (
    !item ||
    item.metadata?.mission_id !== missionId ||
    item.context?.tenant_slug !== state.tenant_slug ||
    item.context?.organization_id !== state.organization_id
  )
    return;
  const { admission, scope } = verifiedDotMissionAdmission(item, deps);
  if (scope.project_id !== state.relationships?.project?.project_id) return;
  if (
    computeApprovalPayloadHash(admission as unknown as Record<string, unknown>) !==
    computeApprovalPayloadHash(brief.missionAdmission as unknown as Record<string, unknown>)
  )
    return;
  const evidence = { ...deps, tenantSlug: state.tenant_slug };
  const receipt = `mission-start:${state.tenant_slug}:${missionId}`;
  recordAutonomyOutcome(
    {
      action_id: 'mission_start_mandate',
      receipt_id: receipt,
      decision: 'approve',
      executed: false,
    },
    evidence
  );
  recordAutonomyExecution(
    { action_id: 'mission_start_mandate', receipt_id: receipt, ok: true },
    evidence
  );
}
