/** Internal Dot -> mission admission. No business effect permission is issued. */
import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { evaluateAutonomousOpsAction } from '../governance/autonomous-ops-gate.js';
import { withExecutionContext } from '../authority.js';
import { resolveAccountableHuman } from '../organization/member-registry.js';
import { isOperationsHalted } from '../governance/operations-halt.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { safeExistsSync, safeMkdir, safeWriteFile } from '../secure-io.js';
import { pathResolver, findMissionPath } from '../path-resolver.js';
import { findDotCharter } from '../dot/dot-charter.js';
import { assertDotAccountabilityCharter } from '../dot/dot-authority.js';
import { readDotActionLedgerStrict } from '../dot/dot-action-ledger.js';
import { dotAdmissionMissionId } from '../dot/dot-admission-identity.js';
import {
  getWorkItem,
  claimWorkItem,
  releaseWorkItem,
  listActiveWorkLeases,
} from '../workforce/work-coordination.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import { normalizeWorkItemContext } from '../workforce/work-coordination-identity.js';
import {
  evaluateMissionStartMandate,
  parseMissionAdmissionRequest,
  type MissionAdmissionRequest,
} from '../governance/mandate-shadow.js';
import {
  computeApprovalPayloadHash,
  computeApprovalPresentedDigest,
} from '../governance/approval-presentation.js';
import { approvalUsabilityRefusal } from '../governance/approval-separation-of-duties.js';
import {
  listApprovalRequests,
  loadApprovalRequest,
  isApprovalRequestExpired,
} from '../governance/approval-store-reader.js';
import { validateHumanFinalDecision } from '../governance/approval-human-decision.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import {
  recordAutonomyExecution,
  recordAutonomyOutcome,
} from '../governance/autonomy-action-state.js';
import { loadState } from './mission-state.js';

type Deps = { rootDir?: string; now?: () => Date };
interface HumanAdmissionApplyBinding {
  workItemId: string;
  requestId: string;
  claimId: string;
  leaseId: string;
  attemptId: string;
}
const humanAdmissionApply = new AsyncLocalStorage<HumanAdmissionApplyBinding>();
/** Carry the freshly acquired durable claim through the in-process controller call; not a reusable grant. */
export function withHumanMissionAdmissionApply<T>(
  binding: HumanAdmissionApplyBinding,
  fn: () => T
): T {
  return humanAdmissionApply.run(binding, fn);
}
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
  const gate = evaluateAutonomousOpsAction({
    actionId: 'mission_start_mandate',
    tenantSlug,
  });
  const hasBoundDecision = listApprovalRequests({
    storageChannels: ['brief'],
    kind: 'mission_gate',
  }).some(
    (record) => record.source?.missionId === missionId && record.source.taskId === workItemId
  );
  if (
    item.metadata?.mission_alignment_preparation ||
    hasBoundDecision ||
    !(gate.allowed && gate.decision === 'auto')
  ) {
    const record = assertHumanMissionAdmissionApproval(item, deps);
    const binding = humanAdmissionApply.getStore();
    const lease = binding
      ? listActiveWorkLeases().find(
          (row) =>
            row.lease_id === binding.leaseId &&
            row.item_id === workItemId &&
            row.holder_peer_id === 'mission_controller'
        )
      : undefined;
    if (
      !record.applyClaim ||
      record.applyResult ||
      !binding ||
      binding.workItemId !== workItemId ||
      binding.requestId !== record.id ||
      binding.claimId !== record.applyClaim.claimId ||
      binding.leaseId !== item.lease_id ||
      item.claimed_by_peer_id !== 'mission_controller' ||
      !lease ||
      item.status !== 'in_progress' ||
      binding.attemptId !== item.current_attempt_id
    )
      throw new Error('mission admission activation requires its current uncompleted apply claim');
  }
}
export function resolveDotMissionAdmission(
  item: WorkItem,
  deps: Deps = {}
): MissionAdmissionRequest {
  return verifiedDotMissionAdmission(item, deps).admission;
}

/** Revalidate current human authority at the controller activation boundary, not only at dispatch. */
export function assertHumanMissionAdmissionApproval(
  item: WorkItem,
  deps: Deps = {}
): ApprovalRequestRecord {
  if (isOperationsHalted()) throw new Error('mission admission operations halted');
  const { admission, scope } = verifiedDotMissionAdmission(item, deps);
  const missionId = item.metadata!.mission_id as string;
  const brief = buildMissionAdmissionBrief(item, admission, missionId);
  const payloadHash = computeApprovalPayloadHash(brief);
  // Re-read durable mission evidence at the final activation boundary, after async work.
  const state = loadState(missionId, deps);
  const dir = findMissionPath(missionId);
  if (
    !state ||
    state.status !== 'planned' ||
    state.tier !== 'confidential' ||
    !dir ||
    state.tenant_slug !== scope.tenant_slug ||
    state.organization_id !== scope.organization_id ||
    state.relationships?.project?.project_id !== scope.project_id ||
    !safeExistsSync(path.join(dir, 'evidence', 'mission-brief.json')) ||
    computeApprovalPayloadHash(
      readMissionAdmissionBrief(path.join(dir, 'evidence', 'mission-brief.json'))
    ) !== payloadHash
  )
    throw new Error('human admission planned mission evidence changed');
  const effectBinding =
    'mission-admission:' +
    computeApprovalPayloadHash({
      action: 'human_mission_alignment',
      itemId: item.item_id,
      missionId,
      actionRef: item.metadata!.action_ref,
      scope,
    });
  const records = listApprovalRequests({
    storageChannels: ['brief'],
    kind: 'mission_gate',
  }).filter((row) => row.source?.missionId === missionId);
  const record = records[0];
  if (
    records.length !== 1 ||
    !record ||
    record.status !== 'approved' ||
    record.source?.taskId !== item.item_id ||
    record.correlationId !== 'mission-alignment-' + missionId ||
    record.accountability?.finalDecision !== 'human_only' ||
    record.accountability.payloadHash !== payloadHash ||
    record.accountability.effectBinding !== effectBinding ||
    record.scope?.tier !== 'confidential' ||
    record.scope.tenant_slug !== scope.tenant_slug ||
    record.scope.organization_id !== scope.organization_id ||
    record.scope.project_id !== scope.project_id ||
    record.scope.mission_id !== missionId ||
    record.scope.task_id !== item.item_id ||
    !record.decidedBy?.trim() ||
    record.decidedByIdentitySource === 'caller_supplied' ||
    record.decidedInAgentSession ||
    record.assuranceShortfall ||
    !record.decidedAt ||
    !Number.isFinite(Date.parse(record.decidedAt)) ||
    !record.verifiedPresentedDigest ||
    record.verifiedPresentedDigest !== computeApprovalPresentedDigest(record) ||
    isApprovalRequestExpired(record) ||
    approvalUsabilityRefusal(record, 'mission_admission_activation')
  )
    throw new Error('current exact human admission approval required');
  validateHumanFinalDecision({
    accountability: record.accountability,
    decidedByType: record.decidedByType,
    authenticated: record.authenticated,
    authMethod: record.decidedAuthMethod,
    phase: 'decision',
    mode: 'enforce',
    channel: record.channel,
    payloadHash,
    effectBinding,
  });
  const member = withExecutionContext('sovereign_concierge', () =>
    resolveAccountableHuman(record.decidedBy!)
  );
  const membership = member?.memberships.find((row) => row.tenant_slug === scope.tenant_slug);
  if (
    member?.status !== 'active' ||
    !membership ||
    !['owner', 'approver'].includes(membership.role)
  )
    throw new Error('human admission requires current tenant approval authority');
  return record;
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
  const record = readDotActionLedgerStrict({ ...deps, dotId: dot.dot_id })
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
      {
        tenant_slug: tenant,
        mandate_id: admission.mandate_ref,
        facts: admission.mandate_facts,
      },
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
export function readMissionAdmissionBrief(file: string): AdmissionBrief {
  return defineCatalog<AdmissionBrief>({
    id: 'mission-admission-brief',
    path: file,
    schema: pathResolver.knowledge('product/schemas/mission-brief.schema.json'),
  }).load();
}

/** Preparation is not activation: author the exact same brief on a planned mission. */
export function prepareMissionAdmissionBrief(
  missionId: string,
  workItemId: string,
  deps: Deps = {}
): void {
  const item = getWorkItem(workItemId, deps);
  if (!item || item.metadata?.mission_id !== missionId)
    throw new Error('mission intake identity mismatch');
  const { admission, scope } = verifiedDotMissionAdmission(item, deps);
  const state = loadState(missionId, deps);
  const dir = findMissionPath(missionId);
  if (
    !state ||
    state.status !== 'planned' ||
    !dir ||
    state.tenant_slug !== scope.tenant_slug ||
    state.organization_id !== scope.organization_id ||
    state.relationships?.project?.project_id !== scope.project_id
  )
    throw new Error('planned mission preparation receipt missing');
  const brief = buildMissionAdmissionBrief(item, admission, missionId);
  withLockSync('mission-admission-brief:' + dir, () => {
    const file = path.join(dir, 'evidence', 'mission-brief.json');
    if (safeExistsSync(file)) {
      if (
        computeApprovalPayloadHash(readMissionAdmissionBrief(file)) !==
        computeApprovalPayloadHash(brief)
      )
        throw new Error('mission admission brief drift');
      return;
    }
    safeMkdir(path.dirname(file), { recursive: true });
    safeWriteFile(file, JSON.stringify(brief, null, 2));
  });
}

export function buildMissionAdmissionBrief(
  item: WorkItem,
  admission: MissionAdmissionRequest,
  missionId: string
): AdmissionBrief {
  return {
    missionId,
    title: item.title,
    intent: item.description,
    tier: 'confidential',
    scope: { in: admission.mandate_facts.paths },
    gate: { riskLevel: admission.mandate_facts.risk_level, approvalRequired: true },
    estimate: {
      cost: admission.mandate_facts.estimated_cost + ' ' + admission.mandate_facts.currency,
    },
    missionAdmission: admission,
    source: {
      kind: 'dot_work_item',
      ref: item.item_id,
      tenantSlug: item.context!.tenant_slug!,
    },
  };
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
        const existing = readMissionAdmissionBrief(file);
        if (
          existing.source?.ref !== item.item_id ||
          computeApprovalPayloadHash(
            existing.missionAdmission as unknown as Record<string, unknown>
          ) !== computeApprovalPayloadHash(admission as unknown as Record<string, unknown>)
        )
          throw new Error('existing mission brief has different admission; human review required');
        return;
      }
      const brief = buildMissionAdmissionBrief(item, admission, missionId);
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
  const approved = listApprovalRequests({
    storageChannels: ['brief'],
    kind: 'mission_gate',
  }).find(
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
  const brief = readMissionAdmissionBrief(path.join(missionDir, 'evidence', 'mission-brief.json'));
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
