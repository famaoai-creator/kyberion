/**
 * `mission_controller supersede-task <MISSION> <task> --by <new_task_id> --reason <text>`
 *
 * Replace a task that can no longer complete (CD-09: its customer decision is
 * unresolvable — the agenda was closed or withdrawn with no confirmed answer)
 * with another task of the same mission, without hand-editing NEXT_TASKS.
 *
 * Trust shape: PI-05, as `mission-work-reconciliation.ts`. Closing a task
 * without its own success mutates the mission exit gate, so it ALWAYS needs an
 * authenticated human `mission_gate` approval (no SUDO shortcut):
 *   1. `--request-approval` opens a request on the `mission-task-supersede`
 *      storage channel, bound to the effect `mission-task-supersede:<M>:<task>`
 *      and hashed over {mission, task, by, reason_sha256};
 *   2. a human sovereign decides it (`pnpm kyberion approvals --approve <id>`);
 *   3. the apply run passes `--approval-request-id <id>`; `--dry-run` checks
 *      the preconditions only.
 *
 * Effects (under the mission lock): the old task becomes `status: superseded`
 * with `superseded = {by_task_id, at, actor_id, reason_sha256,
 * approval_request_id}`; its dependents' dependencies move to the replacement
 * (`dependencies_rewritten_from`), on NEXT_TASKS and on their WorkItems; the
 * old WorkItem is archived with `metadata.superseded_by`; the execution ledger
 * (`task_superseded`), the mission history (`TASK_SUPERSEDED`) and the audit
 * chain (`mission.task_superseded`) carry ids and the reason's SHA-256 only;
 * the reason text stays in the mission receipt
 * `evidence/task-supersede/<task>.json`. The task's customer-decision consumer
 * lock is marked superseded (never released or re-held afterwards).
 */
import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import {
  approvalRequesterActorId,
  resolveApprovalRequesterInput,
  type ApprovalRequesterInput,
  type ApprovalRequesterRef,
} from '../governance/approval-requester.js';
import {
  assertApprovalUsable,
  computeApprovalPayloadHash,
  createApprovalRequest,
  evaluateApprovalUsability,
  isApprovalRequestExpired,
  listApprovalRequests,
  loadApprovalRequest,
  validateHumanFinalDecision,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import { auditChain } from '../governance/audit-chain.js';
import { hasAuthority, resolveIdentityContext } from '../authority.js';
import { logger } from '../core.js';
import { readConfiguredActorIdentity } from '../identity-context-bridge.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { withLock } from '../foundation/lock-utils.js';
import { nowIso } from '../foundation/time.js';
import * as pathResolver from '../path-resolver.js';
import { findMissionPath } from '../path-resolver.js';
import { safeExec, safeExistsSync } from '../secure-io.js';
import {
  getWorkItem,
  listActiveWorkLeases,
  updateWorkItem,
} from '../workforce/work-coordination.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import { readCanonicalWorkGraph, workItemTaskId } from '../workforce/work-graph-projection.js';
import {
  markTaskDecisionLockSuperseded,
  type TaskDecisionLockSupersedeResult,
} from './mission-decision-lock.js';
import { writeDispatchArtifact } from './mission-dispatch-lifecycle.js';
import {
  isTaskSuperseded,
  MISSION_TASK_COMPLETED_STATUSES,
  MISSION_TASK_SUPERSEDED_STATUS,
  readMissionNextTasks,
  writeMissionNextTasks,
} from './mission-lifecycle-completion.js';
import type {
  MissionTaskDependencyRewrite,
  MissionTaskSupersededRecord,
} from './mission-orchestration-worker-contracts.js';
import { loadState, saveState } from './mission-state.js';
import {
  ledgerHasTaskSupersede,
  missionTaskSupersedeReceiptPath,
  MISSION_TASK_SUPERSEDE_APPROVAL_CHANNEL,
  missionTaskSupersedeEffectBinding,
  missionTaskSupersedePayloadFromHash,
} from './mission-task-supersede-proof.js';
import { readJson } from '../foundation/json.js';
import { appendMissionExecutionLedgerEntry } from './mission-team-binding.js';
import { getMissionLabel } from './mission-workitem-dispatch-review.js';
import type { MissionState } from './mission-types.js';

export {
  MISSION_TASK_SUPERSEDE_APPROVAL_CHANNEL,
  missionTaskSupersedeEffectBinding,
  isTaskVerifiablySuperseded,
  missionTaskSupersedeProof,
} from './mission-task-supersede-proof.js';
/** A human approval older than this no longer authorizes the supersede (PI-05 precedent). */
const APPROVAL_TTL_MS = 72 * 60 * 60 * 1000;

export interface MissionTaskSupersedeInput {
  missionId: string;
  taskId: string;
  byTaskId: string;
  reason: string;
}

export interface MissionTaskSupersedeResult {
  status: 'dry_run_ready' | 'applied' | 'already_superseded';
  mission_id: string;
  task_id: string;
  by_task_id: string;
  reason_sha256: string;
  /** Tasks whose dependency on the old task now points at the replacement. */
  rewritten_dependent_task_ids: string[];
  work_item_ids_updated: string[];
  approval_request_id?: string;
  receipt_path?: string;
  /** The consumer lock mark (ids only); absent on a dry run. */
  customer_decision_lock?: TaskDecisionLockSupersedeResult;
}

interface TaskView extends Record<string, unknown> {
  task_id: string;
  status?: string;
  dependencies?: string[];
  superseded?: MissionTaskSupersededRecord;
  dependencies_rewritten_from?: MissionTaskDependencyRewrite[];
}

function assertMissionControllerAuthority(): void {
  const identity = resolveIdentityContext();
  if (identity.role !== 'mission_controller' && !hasAuthority('SUDO')) {
    throw new Error('Mission controller authority is required to supersede a mission task.');
  }
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeInput(input: MissionTaskSupersedeInput): MissionTaskSupersedeInput {
  const missionId = String(input.missionId || '')
    .trim()
    .toUpperCase();
  const taskId = String(input.taskId || '').trim();
  const byTaskId = String(input.byTaskId || '').trim();
  const reason = String(input.reason || '').trim();
  if (!/^[A-Z0-9][A-Z0-9._-]+$/u.test(missionId)) {
    throw new Error(`Invalid mission ID: ${input.missionId}`);
  }
  if (!taskId) throw new Error('supersede-task requires the task id to supersede');
  if (!byTaskId) throw new Error('supersede-task requires --by <new_task_id>');
  if (!reason) throw new Error('supersede-task requires a non-empty --reason <text>');
  return { missionId, taskId, byTaskId, reason };
}

export function missionTaskSupersedeApprovalPayload(
  input: MissionTaskSupersedeInput
): Record<string, string> {
  const normalized = normalizeInput(input);
  return missionTaskSupersedePayloadFromHash({
    missionId: normalized.missionId,
    taskId: normalized.taskId,
    byTaskId: normalized.byTaskId,
    reasonSha256: sha256Text(normalized.reason),
  });
}

/** The executing actor (persona, else the OS user), as reconcile-work records it. */
function actorId(): string {
  return (
    readConfiguredActorIdentity().persona || getRegisteredEnvText('USER') || 'mission_controller'
  );
}

/**
 * The mission's WorkItems (canonical store), by task id: the mission's own
 * project (worker-dispatched items use the mission id) and its linked project.
 */
function missionWorkItemsByTaskId(state: MissionState): Map<string, WorkItem> {
  const missionId = state.mission_id.toUpperCase();
  const byTaskId = new Map<string, WorkItem>();
  const projectIds = [
    ...new Set(
      [missionId, String(state.relationships?.project?.project_id || '').trim()].filter(Boolean)
    ),
  ];
  const tenantSlug = state.tenant_slug?.trim();
  const items = projectIds.flatMap(
    (projectId) => readCanonicalWorkGraph(projectId, tenantSlug ? { tenantSlug } : {}).items
  );
  for (const item of items) {
    const sourceRefMission = /^mission:([^:]+):/u.exec(item.source_ref)?.[1];
    const labelMission = getMissionLabel(item);
    if (
      labelMission?.toUpperCase() !== missionId &&
      sourceRefMission?.toUpperCase() !== missionId
    ) {
      continue;
    }
    const taskId = workItemTaskId(item);
    if (taskId) byTaskId.set(taskId, item);
  }
  return byTaskId;
}

function itemTaskStatus(item: WorkItem): string {
  if (item.status === 'archived' && typeof item.metadata?.superseded_by === 'string') {
    return MISSION_TASK_SUPERSEDED_STATUS;
  }
  switch (item.status) {
    case 'done':
    case 'archived':
      return 'completed';
    case 'review':
      return 'reviewed';
    case 'in_progress':
      return 'in_progress';
    case 'blocked':
      return 'blocked';
    default:
      return 'planned';
  }
}

interface SupersedePlan {
  missionId: string;
  missionPath: string;
  state: MissionState;
  nextTasks: Array<Record<string, unknown>>;
  views: Map<string, TaskView>;
  items: Map<string, WorkItem>;
  dependents: string[];
  /** A partly applied supersede under this approval: its record, to finish it (M1). */
  resumed?: MissionTaskSupersededRecord;
}

function supersededRecordOf(value: unknown): MissionTaskSupersededRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.by_task_id === 'string' &&
    typeof record.approval_request_id === 'string' &&
    typeof record.reason_sha256 === 'string' &&
    typeof record.at === 'string' &&
    typeof record.actor_id === 'string'
    ? (record as unknown as MissionTaskSupersededRecord)
    : undefined;
}

/** The task and every task it waits on, directly or not. */
function dependencyClosure(taskId: string, dependenciesOf: (id: string) => string[]): Set<string> {
  const closure = new Set<string>();
  const stack = [taskId];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (closure.has(next)) continue;
    closure.add(next);
    stack.push(...dependenciesOf(next));
  }
  return closure;
}

/** A completed or superseded task: never rewritten, never a reason to refuse. */
function isClosedTask(view: TaskView): boolean {
  const status = String(view.status || 'planned').toLowerCase();
  return MISSION_TASK_COMPLETED_STATUSES.has(status) || status === MISSION_TASK_SUPERSEDED_STATUS;
}

function taskDependencies(task: Record<string, unknown> | undefined): string[] {
  return Array.isArray(task?.dependencies)
    ? task.dependencies.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
}

/**
 * Read the mission's tasks (NEXT_TASKS, with the canonical WorkItem status and
 * dependencies winning, as readPlannedTasks does) and check every
 * precondition. Throws with the first refusal.
 */
function planSupersede(
  input: MissionTaskSupersedeInput,
  resume?: { approvalRequestId: string; reasonSha256: string }
): SupersedePlan {
  const { missionId, taskId, byTaskId } = input;
  const missionPath = findMissionPath(missionId);
  if (!missionPath) throw new Error(`Mission ${missionId} not found`);
  const state = loadState(missionId);
  if (!state) throw new Error(`Mission ${missionId} state not found`);
  if (state.status === 'archived') throw new Error(`Mission ${missionId} is archived`);

  const nextTasks = readMissionNextTasks(missionPath);
  const items = missionWorkItemsByTaskId(state);
  const views = new Map<string, TaskView>();
  for (const task of nextTasks) {
    const id = String(task.task_id || '').trim();
    if (id) views.set(id, { ...task, task_id: id } as TaskView);
  }
  for (const [id, item] of items) {
    const current = views.get(id) ?? { task_id: id };
    const canonicalDependencies = (item.dependencies || []).map(String).filter(Boolean);
    const itemRecord = supersededRecordOf(item.metadata?.superseded);
    views.set(id, {
      ...current,
      status: itemTaskStatus(item),
      ...(canonicalDependencies.length > 0 ? { dependencies: canonicalDependencies } : {}),
      ...(!current.superseded && itemRecord ? { superseded: itemRecord } : {}),
    });
  }

  if (taskId === byTaskId) throw new Error('A task cannot be superseded by itself');
  const old = views.get(taskId);
  if (!old) throw new Error(`Task ${taskId} not found in mission ${missionId}`);
  const replacement = views.get(byTaskId);
  if (!replacement) {
    throw new Error(
      `Replacement task ${byTaskId} not found in mission ${missionId}: add it to NEXT_TASKS first`
    );
  }
  const oldStatus = String(old.status || 'planned').toLowerCase();
  // M1: a supersede under this very approval that stopped part-way is
  // finished (every effect below is idempotent). Resuming is derived ONLY from
  // the receipt apply writes as its first effect, under the mission lock —
  // never from WorkItem metadata or NEXT_TASKS, which a worker could write.
  const receiptPath = missionTaskSupersedeReceiptPath(missionPath, taskId);
  const receipt =
    resume && safeExistsSync(receiptPath)
      ? readJson<Record<string, unknown>>(receiptPath)
      : undefined;
  const receiptRecord = supersededRecordOf(receipt?.superseded);
  const resumed =
    resume &&
    receipt?.kind === 'mission-task-supersede-receipt' &&
    receiptRecord &&
    receiptRecord.approval_request_id === resume.approvalRequestId &&
    receiptRecord.by_task_id === byTaskId &&
    receiptRecord.reason_sha256 === resume.reasonSha256
      ? receiptRecord
      : undefined;
  // A resumed run's old task may already show its own supersede (archived
  // WorkItem, NEXT_TASKS); the liveness refusals below still apply.
  if (!resumed) {
    if (MISSION_TASK_COMPLETED_STATUSES.has(oldStatus)) {
      throw new Error(`Task ${taskId} is already ${oldStatus}; a completed task is not superseded`);
    }
    if (oldStatus === MISSION_TASK_SUPERSEDED_STATUS) {
      throw new Error(`Task ${taskId} is already superseded`);
    }
  }
  if (oldStatus === 'in_progress') {
    throw new Error(`Task ${taskId} is in progress; wait until its attempt ends`);
  }
  const oldItem = items.get(taskId);
  if (oldItem) {
    // A blocked item's attempt has ended: the worker releases its claim when
    // it blocks (endAttempt). A blocked item that still shows a lease was
    // blocked by an older worker or a caller that kept the claim; its lease
    // is not a live attempt either. Any other leased item is live.
    const live =
      oldItem.status !== 'blocked' &&
      listActiveWorkLeases().some((lease) => lease.item_id === oldItem.item_id);
    if (live || oldItem.status === 'in_progress') {
      throw new Error(
        `Task ${taskId} has a live WorkItem lease (${oldItem.item_id}); wait until its attempt ends`
      );
    }
  }
  if (isTaskSuperseded(replacement)) {
    throw new Error(`Replacement task ${byTaskId} is itself superseded`);
  }
  // The replacement must not wait on the task it replaces, directly or not.
  const seen = new Set<string>();
  const stack = [...taskDependencies(replacement)];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (next === taskId) {
      throw new Error(
        `Replacement task ${byTaskId} depends (transitively) on ${taskId}; it cannot replace it`
      );
    }
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...taskDependencies(views.get(next)));
  }
  // No supersede cycle: following the replacement's own supersede chain never
  // comes back to the task being replaced.
  const chain = new Set<string>([taskId]);
  let cursor: TaskView | undefined = replacement;
  while (cursor?.superseded?.by_task_id) {
    const nextId: string = cursor.superseded.by_task_id;
    if (chain.has(nextId)) throw new Error(`Superseding ${taskId} by ${byTaskId} forms a cycle`);
    chain.add(nextId);
    cursor = views.get(nextId);
  }

  const rawById = new Map(nextTasks.map((task) => [String(task.task_id || '').trim(), task]));
  const dependents: string[] = [];
  for (const view of views.values()) {
    // A closed task (completed or superseded) keeps its history: neither
    // rewritten nor a reason to refuse (m2).
    if (view.task_id === taskId || isClosedTask(view)) continue;
    // Canonical (WorkItem) or board (NEXT_TASKS) dependency: both are rewritten.
    if (
      !taskDependencies(view).includes(taskId) &&
      !taskDependencies(rawById.get(view.task_id)).includes(taskId)
    ) {
      continue;
    }
    // A live review of the old task's deliverable cannot be pointed at another
    // task (its deliverable is REVIEW-<task>.md): supersede it first.
    if (String(view.review_target || '') === taskId) {
      throw new Error(
        `Task ${view.task_id} reviews ${taskId} (review_target); supersede ${view.task_id} first`
      );
    }
    dependents.push(view.task_id);
  }
  return {
    missionId,
    missionPath,
    state,
    nextTasks,
    views,
    items,
    dependents: dependents.sort(),
    ...(resumed ? { resumed } : {}),
  };
}

function assertSupersedeApproval(
  approvalRequestId: string,
  input: MissionTaskSupersedeInput,
  options: { allowExpired?: boolean } = {}
): ApprovalRequestRecord {
  const approval = loadApprovalRequest(MISSION_TASK_SUPERSEDE_APPROVAL_CHANNEL, approvalRequestId);
  if (!approval || approval.kind !== 'mission_gate' || approval.status !== 'approved') {
    throw new Error(
      `[POLICY_VIOLATION] supersede-task requires an approved mission_gate request: ${approvalRequestId}`
    );
  }
  // N2: expiry gates only the START of a supersede (checked again under the
  // mission lock once it is known whether this run starts or finishes one).
  if (!options.allowExpired && isApprovalRequestExpired(approval)) {
    throw new Error(`[POLICY_VIOLATION] supersede-task approval has expired: ${approval.id}`);
  }
  // Separation-of-duties consumer id: approval-sod-consumers.contract.test.ts.
  assertApprovalUsable(approval, { consumer: 'mission_task_supersede' });
  if (approval.source?.missionId?.toUpperCase() !== input.missionId) {
    throw new Error('[POLICY_VIOLATION] supersede-task approval is bound to a different mission');
  }
  const effectBinding = missionTaskSupersedeEffectBinding(input.missionId, input.taskId);
  if (approval.accountability?.effectBinding !== effectBinding) {
    throw new Error('[POLICY_VIOLATION] supersede-task approval is bound to a different task');
  }
  const payloadHash = computeApprovalPayloadHash(missionTaskSupersedeApprovalPayload(input));
  if (approval.accountability?.payloadHash !== payloadHash) {
    throw new Error(
      '[POLICY_VIOLATION] supersede-task approval is bound to a different replacement or reason'
    );
  }
  const humanApproval = approval.workflow?.approvals?.find(
    (entry) =>
      entry.status === 'approved' && entry.decidedByType === 'human' && entry.authenticated === true
  );
  if (!humanApproval) {
    throw new Error('[POLICY_VIOLATION] supersede-task requires an authenticated human approval');
  }
  validateHumanFinalDecision({
    accountability: approval.accountability,
    decidedByType: humanApproval.decidedByType,
    authenticated: humanApproval.authenticated,
    authMethod: humanApproval.authMethod,
    payloadHash: humanApproval.payloadHash,
    effectBinding: humanApproval.effectBinding,
    phase: 'recheck',
  });
  return approval;
}

/** Open (or reuse) the human approval request a supersede needs. */
export function createMissionTaskSupersedeApprovalRequest(
  rawInput: MissionTaskSupersedeInput & {
    requestedBy?: string;
    /** The requester the CLI entry point resolved (`cli-operator-principal.ts`). */
    requester?: ApprovalRequesterInput;
  }
): ApprovalRequestRecord {
  assertMissionControllerAuthority();
  const input = normalizeInput(rawInput);
  // A human is never asked to approve what cannot be applied.
  const plan = planSupersede(input);
  const effectBinding = missionTaskSupersedeEffectBinding(input.missionId, input.taskId);
  const payloadHash = computeApprovalPayloadHash(missionTaskSupersedeApprovalPayload(input));
  const existing = listApprovalRequests({
    storageChannels: [MISSION_TASK_SUPERSEDE_APPROVAL_CHANNEL],
    kind: 'mission_gate',
    status: ['pending', 'approved'],
  }).find(
    (record) =>
      record.source?.missionId?.toUpperCase() === input.missionId &&
      record.accountability?.payloadHash === payloadHash &&
      !isApprovalRequestExpired(record) &&
      // Separation of duties: never hand back an approved record that cannot be used.
      (record.status !== 'approved' || !evaluateApprovalUsability(record))
  );
  if (existing) return existing;

  const requester: ApprovalRequesterRef = rawInput.requester
    ? resolveApprovalRequesterInput(rawInput.requester)
    : { requestedBy: rawInput.requestedBy?.trim() || actorId() };
  const details = [
    `Mission: ${input.missionId}`,
    `Task to supersede: ${input.taskId}`,
    `Replacement task: ${input.byTaskId}`,
    `Dependents moved to the replacement: ${plan.dependents.join(', ') || '-'}`,
    `Reason: ${input.reason}`,
    `Reason SHA-256: ${sha256Text(input.reason)}`,
    `Requested by: ${requester.requestedBy}`,
    `Effect if approved: ${input.taskId} is closed as superseded (it never completes), the finish gate no longer waits for it, and its customer-decision lock is frozen; ${input.byTaskId} still has to complete.`,
  ].join('\n');
  return createApprovalRequest('mission_controller', {
    channel: MISSION_TASK_SUPERSEDE_APPROVAL_CHANNEL,
    storageChannel: MISSION_TASK_SUPERSEDE_APPROVAL_CHANNEL,
    threadTs: input.missionId,
    correlationId: effectBinding,
    requestedBy: requester.requestedBy,
    ...(requester.displayName ? { requestedByDisplayName: requester.displayName } : {}),
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    kind: 'mission_gate',
    draft: {
      title: `Supersede task ${input.taskId}: ${input.missionId}`,
      summary: `Approve closing ${input.taskId} as superseded by ${input.byTaskId}.`,
      details,
      severity: 'high',
    },
    source: { missionId: input.missionId },
    requestedByContext: {
      surface: 'terminal',
      actorId: approvalRequesterActorId(requester),
      actorRole: 'mission-task-supersede',
      missionId: input.missionId,
    },
    justification: {
      reason:
        'Superseding a task closes it without its own success and changes the mission exit gate; it requires operator approval.',
      requestedEffects: [effectBinding],
      impactSummary: details,
    },
    risk: {
      level: 'high',
      restartScope: 'manual',
      requiresStrongAuth: true,
      policyId: 'PI-05',
    },
    workflow: {
      workflowId: `pi-05-task-supersede-${input.missionId}-${input.taskId}`,
      mode: 'all_required',
      requiredRoles: ['sovereign'],
      stages: [],
      approvals: [{ role: 'sovereign', status: 'pending' }],
    },
    accountability: {
      finalDecision: 'human_only',
      payloadHash,
      effectBinding,
    },
  });
}

function rewriteDependencies(
  dependencies: string[],
  from: string,
  to: string
): { dependencies: string[]; changed: boolean } {
  if (!dependencies.includes(from)) return { dependencies, changed: false };
  const rewritten = [...new Set(dependencies.map((entry) => (entry === from ? to : entry)))];
  return { dependencies: rewritten, changed: true };
}

function withRewrite(
  existing: unknown,
  rewrite: MissionTaskDependencyRewrite
): MissionTaskDependencyRewrite[] {
  const previous = Array.isArray(existing) ? (existing as MissionTaskDependencyRewrite[]) : [];
  return previous.some((entry) => entry.from === rewrite.from && entry.to === rewrite.to)
    ? previous
    : [...previous, rewrite];
}

/**
 * Supersede a mission task (see the module header). `dryRun` checks every
 * precondition, reports the dependents it would move and never writes; the
 * apply run needs an approved, hash-bound, authenticated human `mission_gate`
 * request.
 *
 * Every effect is idempotent and NEXT_TASKS (what the finish gate and the
 * supersede proof read) is written last: a run that stops part-way is
 * finished by re-running it with the same approval, and a complete one
 * re-run reports `already_superseded` (it only retries the lock mark).
 */
export async function supersedeMissionTask(
  rawInput: MissionTaskSupersedeInput & { dryRun?: boolean; approvalRequestId?: string }
): Promise<MissionTaskSupersedeResult> {
  assertMissionControllerAuthority();
  const input = normalizeInput(rawInput);
  const reasonSha256 = sha256Text(input.reason);
  const base = {
    mission_id: input.missionId,
    task_id: input.taskId,
    by_task_id: input.byTaskId,
    reason_sha256: reasonSha256,
  };
  const approvalRequestId = rawInput.approvalRequestId?.trim();
  if (rawInput.dryRun) {
    // m1: a dry run reads only.
    const plan = planSupersede(input);
    return {
      status: 'dry_run_ready',
      ...base,
      rewritten_dependent_task_ids: plan.dependents,
      work_item_ids_updated: [],
      ...(approvalRequestId ? { approval_request_id: approvalRequestId } : {}),
    };
  }
  if (!approvalRequestId) {
    throw new Error(
      '[POLICY_VIOLATION] supersede-task apply requires --approval-request-id for an authenticated human approval (open one with --request-approval)'
    );
  }
  // Every check but expiry here: a run that finishes a supersede this
  // approval already started may do so after the approval expired (N2).
  const approval = assertSupersedeApproval(approvalRequestId, input, { allowExpired: true });
  const approvalId = approvalRequestId;

  const applied = await withLock(`mission-${input.missionId}`, async () => {
    const plan = planSupersede(input, { approvalRequestId: approvalId, reasonSha256 });
    if (!plan.resumed && isApprovalRequestExpired(approval)) {
      throw new Error(`[POLICY_VIOLATION] supersede-task approval has expired: ${approval.id}`);
    }
    const executor = actorId();
    const record: MissionTaskSupersededRecord = plan.resumed ?? {
      by_task_id: input.byTaskId,
      at: nowIso(),
      actor_id: executor,
      reason_sha256: reasonSha256,
      approval_request_id: approvalId,
    };
    const at = record.at;
    const rewrite: MissionTaskDependencyRewrite = { from: input.taskId, to: input.byTaskId, at };
    const dependents = new Set(plan.dependents);
    let changed = false;

    // 0. The receipt first (the only place the reason text is kept): it is
    //    the evidence a re-run resumes from, and the proof requires it.
    const receiptPath = missionTaskSupersedeReceiptPath(plan.missionPath, input.taskId);
    const receiptRelative = pathResolver.toRepoRelative(receiptPath);
    const existingReceipt = safeExistsSync(receiptPath)
      ? readJson<Record<string, unknown>>(receiptPath)
      : undefined;
    const receiptBody = (auditRecordedAt?: string) => ({
      kind: 'mission-task-supersede-receipt',
      version: '1.0.0',
      ...base,
      reason: input.reason,
      superseded: record,
      rewritten_dependent_task_ids: Array.isArray(existingReceipt?.rewritten_dependent_task_ids)
        ? existingReceipt.rewritten_dependent_task_ids
        : plan.dependents,
      ...(auditRecordedAt ? { audit_recorded_at: auditRecordedAt } : {}),
    });
    const writeReceipt = (auditRecordedAt?: string) =>
      writeDispatchArtifact(receiptPath, receiptBody(auditRecordedAt), {
        missionId: input.missionId,
        missionPath: plan.missionPath,
      });
    if (!existingReceipt) {
      writeReceipt();
      changed = true;
    }

    // 1. Canonical WorkItems: the old one archived with superseded_by, the
    //    dependents' dependencies moved (each skipped once done).
    const workItemIdsUpdated: string[] = [];
    const oldItem = plan.items.get(input.taskId);
    if (oldItem) {
      const current = getWorkItem(oldItem.item_id) ?? oldItem;
      if (current.status !== 'archived' || current.metadata?.superseded_by !== input.byTaskId) {
        updateWorkItem({
          itemId: current.item_id,
          expectedVersion: current.version,
          status: 'archived',
          metadata: {
            ...(current.metadata || {}),
            superseded_by: input.byTaskId,
            superseded: record,
            summary: `Superseded by ${input.byTaskId}`,
          },
        });
        workItemIdsUpdated.push(current.item_id);
      }
    }
    const rewriteWorkItemDependencies = (item: WorkItem): void => {
      const current = getWorkItem(item.item_id) ?? item;
      const metadata = current.metadata || {};
      const canonical = rewriteDependencies(
        (current.dependencies || []).map(String),
        input.taskId,
        input.byTaskId
      );
      const metadataDependencies = Array.isArray(metadata.dependencies)
        ? rewriteDependencies(
            (metadata.dependencies as unknown[]).map(String),
            input.taskId,
            input.byTaskId
          )
        : null;
      if (!canonical.changed && !metadataDependencies?.changed) return;
      updateWorkItem({
        itemId: current.item_id,
        expectedVersion: current.version,
        ...(canonical.changed ? { dependencies: canonical.dependencies } : {}),
        metadata: {
          ...metadata,
          ...(metadataDependencies?.changed
            ? { dependencies: metadataDependencies.dependencies }
            : {}),
          dependencies_rewritten_from: withRewrite(metadata.dependencies_rewritten_from, rewrite),
        },
      });
      workItemIdsUpdated.push(current.item_id);
    };
    for (const dependentId of plan.dependents) {
      const item = plan.items.get(dependentId);
      if (item) rewriteWorkItemDependencies(item);
    }
    if (workItemIdsUpdated.length > 0) changed = true;

    // 2. The audit entry the receipt records as written (so a re-run never
    //    audits twice).
    // A receipt left unstamped by an earlier run may sit after a recorded
    // audit (a crash between the two): look for that run's entry, keyed by
    // the approval, before recording. A fresh receipt cannot have one (the
    // audit always follows the receipt), so the chain is scanned only then.
    const auditedBefore =
      existingReceipt !== undefined &&
      typeof existingReceipt.audit_recorded_at !== 'string' &&
      auditChain
        .loadAll()
        .some(
          (entry) =>
            entry.action === 'mission.task_superseded' &&
            entry.metadata?.approval_request_id === approvalId &&
            entry.metadata?.task_id === input.taskId
        );
    if (auditedBefore) {
      writeReceipt(nowIso());
      changed = true;
    } else if (typeof existingReceipt?.audit_recorded_at !== 'string') {
      auditChain.record({
        agentId: executor,
        action: 'mission.task_superseded',
        operation: `supersede-task:${input.missionId}`,
        result: 'completed',
        metadata: {
          mission_id: input.missionId,
          task_id: input.taskId,
          by_task_id: input.byTaskId,
          reason_sha256: reasonSha256,
          approval_request_id: approvalId,
          rewritten_dependent_task_ids: plan.dependents,
          receipt_path: receiptRelative,
        },
      });
      writeReceipt(nowIso());
      changed = true;
    }

    // 3. Execution ledger (once per approval).
    if (!ledgerHasTaskSupersede(plan.missionPath, input.taskId, approvalId)) {
      appendMissionExecutionLedgerEntry({
        mission_id: input.missionId,
        mission_path_hint: plan.missionPath,
        event_type: 'task_superseded',
        task_id: input.taskId,
        actor_id: executor,
        actor_type: 'human',
        decision: `superseded by ${input.byTaskId}`,
        evidence: [receiptRelative],
        payload: {
          by_task_id: input.byTaskId,
          reason_sha256: reasonSha256,
          approval_request_id: approvalId,
          rewritten_dependent_task_ids: plan.dependents,
        },
      });
      changed = true;
    }

    // 4. NEXT_TASKS last: the finish gate and the supersede proof read it.
    //    Applied to the board read under its writer lease, not to the plan's
    //    copy: a worker result written since the plan was read is kept, and a
    //    dependent added since then is rewritten too (a late dependent).
    const lateDependents = new Set<string>();
    // A late dependent the replacement waits on (or the replacement itself)
    // is left as it is: pointing it at the replacement would make it wait on
    // itself. It stays pending on the superseded task for the operator.
    const leftLateDependents = new Set<string>();
    const nextTasksChanged = writeMissionNextTasks(
      plan.missionPath,
      (onDisk) => {
        let boardChanged = false;
        const boardById = new Map(
          onDisk.map((task) => [String(task.task_id || '').trim(), task] as const)
        );
        const replacementWaitsOn = dependencyClosure(input.byTaskId, (id) =>
          taskDependencies(boardById.get(id))
        );
        const nextTasks = onDisk.map((task) => {
          const id = String(task.task_id || '').trim();
          if (id === input.taskId) {
            if (isTaskSuperseded(task) && supersededRecordOf(task.superseded)) return task;
            boardChanged = true;
            return { ...task, status: MISSION_TASK_SUPERSEDED_STATUS, superseded: record };
          }
          // A dependent closed since the plan keeps its history (m2).
          if (isClosedTask({ ...task, task_id: id })) return task;
          const next = rewriteDependencies(taskDependencies(task), input.taskId, input.byTaskId);
          if (!next.changed) return task;
          if (!dependents.has(id)) {
            // A review of the old task cannot be pointed at another task; it
            // stays pending, as the plan would have refused it.
            if (String(task.review_target || '') === input.taskId) return task;
            if (replacementWaitsOn.has(id)) {
              leftLateDependents.add(id);
              return task;
            }
            lateDependents.add(id);
          }
          boardChanged = true;
          return {
            ...task,
            dependencies: next.dependencies,
            dependencies_rewritten_from: withRewrite(task.dependencies_rewritten_from, rewrite),
          };
        });
        return boardChanged ? nextTasks : undefined;
      },
      { allowSupersede: true }
    );
    if (nextTasksChanged) changed = true;
    // A canonical dependent added since the plan (its board entry may not
    // exist yet) is rewritten the same way.
    const canonicalItems = new Map(
      [...missionWorkItemsByTaskId(plan.state)].map(
        ([id, item]) => [id, getWorkItem(item.item_id) ?? item] as const
      )
    );
    const itemDependencies = (item: WorkItem | undefined): string[] => [
      ...(item?.dependencies || []).map(String),
      ...(Array.isArray(item?.metadata?.dependencies)
        ? (item.metadata.dependencies as unknown[]).map(String)
        : []),
    ];
    const replacementItemWaitsOn = dependencyClosure(input.byTaskId, (id) =>
      itemDependencies(canonicalItems.get(id))
    );
    for (const [id, current] of canonicalItems) {
      if (id === input.taskId || dependents.has(id)) continue;
      if (isClosedTask({ task_id: id, status: itemTaskStatus(current) })) continue;
      if (String(current.metadata?.review_target || '') === input.taskId) continue;
      if (!itemDependencies(current).includes(input.taskId)) continue;
      if (replacementItemWaitsOn.has(id) || leftLateDependents.has(id)) {
        leftLateDependents.add(id);
        continue;
      }
      rewriteWorkItemDependencies(current);
      lateDependents.add(id);
      changed = true;
    }
    if (leftLateDependents.size > 0) {
      logger.warn(
        `supersede-task: ${[...leftLateDependents].sort().join(', ')} came to depend on ${input.taskId} during this run, but ${input.byTaskId} waits on them — they still wait on ${input.taskId} | remove that dependency, then re-run supersede-task with the same approval | mission=${input.missionId}`
      );
    }
    if (lateDependents.size > 0) {
      logger.info(
        `supersede-task: ${[...lateDependents].sort().join(', ')} came to depend on ${input.taskId} during this run and now depend on ${input.byTaskId}.`
      );
    }

    // 5. History (once per approval) and the commit, like record-evidence but
    //    only in the mission's own repository (never the enclosing checkout).
    const currentState = loadState(input.missionId);
    if (!currentState) throw new Error(`Mission ${input.missionId} state disappeared`);
    const historyNote = `${input.taskId} superseded by ${input.byTaskId} (approval ${approvalId})`;
    const hasHistory = currentState.history.some(
      (entry) => entry.event === 'TASK_SUPERSEDED' && entry.note === historyNote
    );
    if (changed || !hasHistory) {
      const missionRepo = safeExistsSync(nodePath.join(plan.missionPath, '.git'));
      if (missionRepo) {
        try {
          safeExec('git', ['add', '.'], { cwd: plan.missionPath });
          safeExec(
            'git',
            ['commit', '-m', `supersede(${input.missionId}): ${input.taskId} -> ${input.byTaskId}`],
            { cwd: plan.missionPath }
          );
        } catch (_) {
          logger.info('No new changes in mission repo after supersede-task.');
        }
        try {
          const head = safeExec('git', ['rev-parse', 'HEAD'], { cwd: plan.missionPath }).trim();
          if (head) currentState.git.latest_commit = head;
        } catch (error) {
          logger.warn(
            `mission HEAD not refreshed after supersede-task — ${error instanceof Error ? error.message : String(error)} | the supersede is recorded; the next checkpoint refreshes it | mission=${input.missionId}`
          );
        }
      }
      if (!hasHistory) {
        currentState.history.push({ ts: at, event: 'TASK_SUPERSEDED', note: historyNote });
        changed = true;
      }
      await saveState(input.missionId, currentState, { alreadyLocked: true });
    }

    return {
      status: changed ? ('applied' as const) : ('already_superseded' as const),
      ...base,
      rewritten_dependent_task_ids: [...new Set([...plan.dependents, ...lateDependents])].sort(),
      work_item_ids_updated: workItemIdsUpdated,
      approval_request_id: approvalId,
      receipt_path: receiptRelative,
    };
  });

  // 6. The task's customer-decision lock, once the mission proves the
  //    supersede (best-effort; the case lock is taken outside the mission lock).
  const lockMark = markTaskDecisionLockSuperseded({
    missionId: input.missionId,
    taskId: input.taskId,
    byTaskId: input.byTaskId,
    approvalRequestId: approvalId,
  });
  if (applied.status === 'applied') {
    logger.success(`Superseded ${input.taskId} by ${input.byTaskId} in ${input.missionId}.`);
  }
  return { ...applied, customer_decision_lock: lockMark };
}
