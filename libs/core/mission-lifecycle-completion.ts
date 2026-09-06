/**
 * Mission completion preparation: evidence collection, deliverable publication,
 * task reconciliation, and goal/repair task materialization.
 */

import * as path from 'node:path';
import { createActuatorTrace } from './actuator-trace.js';
import * as customerResolver from './customer-resolver.js';
import * as pathResolver from './path-resolver.js';
import { findMissionPath } from './path-resolver.js';
import { logger } from './core.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import {
  assertSafeRepositoryPath,
  safeAppendFileSync,
  safeCopyFileSync,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeStat,
  safeWriteFile,
} from './secure-io.js';
import {
  loadVolatileSidecarAtPath,
  saveVolatileSidecarAtPath,
  volatileSidecarPath,
} from './volatile-knowledge.js';
import {
  evaluateArtifactReviews,
  hashArtifactForReview,
  loadArtifactReviewReceipt,
  receiptToArtifactReviewDecision,
} from './artifact-review.js';
import { loadState } from './mission-state.js';
import { nowIso } from './foundation/time.js';
import { readTextFile } from './foundation/text.js';
import type { IntentReconciliationInput } from './intent-reconciliation.js';
import {
  loadMissionNextTaskObjectsAtPath,
  validateMissionNextTaskObjects,
} from './mission-next-task-reader.js';

const DELIVERY_PACK_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/delivery-pack.schema.json'
);
const deliveryPackCatalog = defineCatalog<Record<string, unknown>>({
  id: 'delivery-pack',
  path: DELIVERY_PACK_SCHEMA_PATH,
  schema: DELIVERY_PACK_SCHEMA_PATH,
});

function safeMissionDir(missionDir: string, allowMissingLeaf = false): string {
  return assertSafeRepositoryPath(missionDir, { allowMissingLeaf });
}

function safeMissionPath(
  missionDir: string,
  relativePath: string,
  allowMissingLeaf = false
): string {
  const safeDir = safeMissionDir(missionDir, allowMissingLeaf);
  if (path.isAbsolute(relativePath)) {
    throw new Error(
      `[RESOURCE_PATH_SCOPE] mission-relative path must not be absolute: ${relativePath}`
    );
  }
  const resolved = path.resolve(safeDir, relativePath);
  if (resolved !== safeDir && !resolved.startsWith(`${safeDir}${path.sep}`)) {
    throw new Error(
      `[RESOURCE_PATH_SCOPE] mission path escapes mission directory: ${relativePath}`
    );
  }
  return assertSafeRepositoryPath(resolved, { allowMissingLeaf });
}

function requireSafeMissionId(missionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(missionId)) {
    throw new Error(`[RESOURCE_PATH_SCOPE] invalid mission id: ${missionId}`);
  }
  return missionId;
}

export function collectMissionEvidence(missionDir: string): Array<{ ref: string; text?: string }> {
  const safeDir = safeMissionDir(missionDir, true);
  const evidenceDir = safeMissionPath(safeDir, 'evidence', true);
  if (!safeExistsSync(evidenceDir)) return [];
  return safeReaddir(evidenceDir)
    .filter((entry) => entry !== '.gitkeep')
    .map((entry) => safeMissionPath(safeDir, path.join('evidence', entry)))
    .filter((ref) => {
      try {
        return safeStat(ref).isFile();
      } catch {
        return false;
      }
    })
    .map((ref) => {
      let text: string | undefined;
      try {
        text = readTextFile(ref).slice(0, 2000);
      } catch (err) {
        logger.warn(`[mission-lifecycle] suppressed error in collectMissionEvidence: ${err}`);
      }
      return { ref, text };
    });
}
export interface MissionCompletionReconciliationContext {
  reconciliationInput: IntentReconciliationInput;
  completionGoal: { summary: string; success_condition: string };
  evidence: Array<{ ref: string; text?: string }>;
  evidenceRefs: string[];
}

/**
 * SO-04: the exact `reconciliationInput` construction `finishMission` below
 * builds from mission state + evidence, extracted so the surface-steering
 * finish verb (`libs/core/surface-mission-steering.ts`) can run the SAME
 * IL-04 check BEFORE it ever calls the lifecycle facade's `finish`, using
 * the identical goal/evidence shape instead of re-deriving its own —
 * avoiding drift between "what the CLI-owned finish path checks" and "what
 * the surface-owned finish verb checks". Accepts pre-loaded state/missionDir
 * so `finishMission` (which already loaded both) doesn't re-read them.
 */
export function buildMissionCompletionReconciliationInput(
  missionId: string,
  preloaded?: { state?: ReturnType<typeof loadState>; missionDir?: string | null }
): MissionCompletionReconciliationContext | null {
  const upperId = missionId.toUpperCase();
  const missionDir =
    preloaded?.missionDir !== undefined ? preloaded.missionDir : findMissionPath(upperId);
  if (!missionDir) return null;
  const state = preloaded?.state !== undefined ? preloaded.state : loadState(upperId);
  if (!state) return null;

  const evidence = collectMissionEvidence(missionDir);
  const evidenceRefs = evidence.map((item) => item.ref);
  const completionGoal = {
    summary:
      state.intent?.goal_summary ||
      state.outcome_contract?.requested_result ||
      `Mission ${upperId}`,
    success_condition:
      state.intent?.success_condition ||
      state.outcome_contract?.success_criteria?.join('; ') ||
      state.outcome_contract?.requested_result ||
      `Mission ${upperId}`,
  };
  return {
    reconciliationInput: {
      goal: completionGoal,
      evidenceRefs,
      requestedResult: state.outcome_contract?.requested_result,
    },
    completionGoal,
    evidence,
    evidenceRefs,
  };
}

export function publishMeetingDeliverablesIfNeeded(input: {
  missionId: string;
  missionDir: string;
  state: any;
  completionNextAction: any;
  traceCtx: ReturnType<typeof createActuatorTrace>;
}): void {
  if (input.state.mission_type !== 'meeting_facilitation') return;

  let activeCustomerSlug: string | null = null;
  try {
    activeCustomerSlug = customerResolver.activeCustomer(process.env);
  } catch (err: any) {
    logger.warn(
      `⚠️ [DELIVERY] Meeting deliverables skipped for ${input.missionId}: ${err?.message || err}`
    );
    input.traceCtx.addEvent('meeting_delivery.skipped', {
      reason: 'invalid_customer_slug',
    });
    return;
  }

  const tenantSlug = String(input.state.tenant_slug || '').trim();
  if (!tenantSlug || !activeCustomerSlug || activeCustomerSlug !== tenantSlug) {
    input.traceCtx.addEvent('meeting_delivery.skipped', {
      reason: !tenantSlug ? 'missing_tenant_slug' : 'customer_mismatch',
    });
    return;
  }

  const customerRoot = customerResolver.customerRoot('', process.env);
  if (!customerRoot || !safeExistsSync(customerRoot)) {
    logger.warn(
      `⚠️ [DELIVERY] Meeting deliverables skipped for ${input.missionId}: customer root missing for ${tenantSlug}.`
    );
    input.traceCtx.addEvent('meeting_delivery.skipped', {
      reason: 'customer_root_missing',
    });
    return;
  }

  const safeMissionPathRoot = safeMissionDir(input.missionDir);
  const safeCustomerRoot = assertSafeRepositoryPath(customerRoot);
  const safeMissionId = requireSafeMissionId(input.missionId);
  const evidenceDir = safeMissionPath(safeMissionPathRoot, 'evidence');
  const deliverablesRoot = assertSafeRepositoryPath(path.join(safeCustomerRoot, 'deliverables'), {
    allowMissingLeaf: true,
  });
  const missionDeliverablesDir = assertSafeRepositoryPath(
    path.join(deliverablesRoot, safeMissionId),
    { allowMissingLeaf: true }
  );
  safeMkdir(missionDeliverablesDir, { recursive: true });

  const copiedArtifacts: Array<{ kind: string; path: string; description: string }> = [];
  const copyArtifact = (relativeName: string, kind: string, description: string): void => {
    const sourcePath = assertSafeRepositoryPath(path.join(evidenceDir, relativeName));
    if (!safeExistsSync(sourcePath)) return;
    if (!safeLstat(sourcePath).isFile()) {
      throw new Error(`[DELIVERY_RESOURCE] evidence must be a regular file: ${sourcePath}`);
    }
    const destinationPath = assertSafeRepositoryPath(
      path.join(missionDeliverablesDir, relativeName),
      { allowMissingLeaf: true }
    );
    safeMkdir(path.dirname(destinationPath), { recursive: true });
    safeCopyFileSync(sourcePath, destinationPath);
    copiedArtifacts.push({
      kind,
      path: path.relative(safeCustomerRoot, destinationPath),
      description,
    });
  };

  copyArtifact('minutes.md', 'minutes', 'Meeting minutes for the follow-up delivery.');
  copyArtifact(
    'action-items.jsonl',
    'action-items',
    'Structured action items captured from the meeting.'
  );
  copyArtifact(
    'meeting-followup-pack.json',
    'delivery-pack-source',
    'Pipeline-generated follow-up pack.'
  );

  if (copiedArtifacts.length === 0) {
    logger.warn(
      `⚠️ [DELIVERY] Meeting deliverables skipped for ${input.missionId}: no follow-up evidence found under ${evidenceDir}.`
    );
    input.traceCtx.addEvent('meeting_delivery.skipped', {
      reason: 'no_followup_evidence',
    });
    return;
  }

  let minutesExcerpt = '';
  const minutesPath = assertSafeRepositoryPath(path.join(missionDeliverablesDir, 'minutes.md'));
  if (safeExistsSync(minutesPath)) {
    if (!safeLstat(minutesPath).isFile()) {
      throw new Error(`[DELIVERY_RESOURCE] minutes must be a regular file: ${minutesPath}`);
    }
    const minutes = readTextFile(minutesPath);
    minutesExcerpt = minutes.split(/\r?\n/u).slice(0, 8).join('\n').trim();
  }

  const summary = [
    `Meeting follow-up delivered for ${input.missionId} to customer ${tenantSlug}.`,
    input.completionNextAction?.request || input.state.outcome_contract?.requested_result || '',
  ]
    .filter(Boolean)
    .join(' ');
  const pack = {
    kind: 'delivery-pack',
    pack_id: `${input.missionId}-meeting-delivery`,
    summary,
    request_text:
      input.completionNextAction?.request || input.state.outcome_contract?.requested_result,
    ...(minutesExcerpt ? { conversation_summary: minutesExcerpt } : {}),
    recommended_next_action: input.completionNextAction?.next_step,
    artifacts_by_role: {
      primary: [
        path.relative(safeCustomerRoot, path.join(missionDeliverablesDir, 'delivery-summary.md')),
      ],
      evidence: copiedArtifacts.map((artifact) => artifact.path),
    },
    artifacts: copiedArtifacts.map((artifact, index) => ({
      id: `${input.missionId}-${index + 1}`,
      kind: artifact.kind,
      path: artifact.path,
      description: artifact.description,
    })),
  };

  safeWriteFile(
    assertSafeRepositoryPath(path.join(missionDeliverablesDir, 'delivery-summary.md'), {
      allowMissingLeaf: true,
    }),
    [
      `# Meeting Delivery Summary`,
      ``,
      `- Mission: ${input.missionId}`,
      `- Tenant: ${tenantSlug}`,
      `- Summary: ${summary}`,
      `- Deliverables:`,
      ...copiedArtifacts.map((artifact) => `  - ${artifact.path} (${artifact.kind})`),
    ].join('\n')
  );
  const deliveryPackPath = assertSafeRepositoryPath(
    path.join(missionDeliverablesDir, 'delivery-pack.json'),
    { allowMissingLeaf: true }
  );
  const validatedPack = deliveryPackCatalog.validate(pack, deliveryPackPath);
  safeWriteFile(deliveryPackPath, JSON.stringify(validatedPack, null, 2));

  const deliveryLogPath = assertSafeRepositoryPath(
    path.join(deliverablesRoot, 'delivery-log.jsonl'),
    {
      allowMissingLeaf: true,
    }
  );
  safeAppendFileSync(
    deliveryLogPath,
    `${JSON.stringify({
      mission_id: input.missionId,
      tenant_slug: tenantSlug,
      delivered_at: nowIso(),
      deliverable_dir: path.relative(pathResolver.rootDir(), missionDeliverablesDir),
      artifacts: copiedArtifacts.map((artifact) => artifact.path),
      summary,
    })}\n`
  );

  input.traceCtx.addEvent('meeting_delivery.published', {
    artifact_count: copiedArtifacts.length,
  });
  logger.info(
    `📦 [DELIVERY] Published meeting deliverables for ${input.missionId} to ${path.relative(
      pathResolver.rootDir(),
      missionDeliverablesDir
    )}.`
  );
}

export function extractPromotableMissionMemory(raw: string): string | null {
  const lines = raw.split(/\r?\n/u);
  const collected: string[] = [];
  let capturing = false;

  for (const line of lines) {
    if (/^##\s+(Decisions|Lessons Learned)\s*$/iu.test(line.trim())) {
      capturing = true;
      continue;
    }
    if (capturing && /^##\s+/u.test(line.trim())) {
      capturing = false;
    }
    if (capturing && line.trim() && !/^<!--.*-->$/u.test(line.trim())) {
      collected.push(line.trim());
    }
  }

  const summary = collected.join('\n').trim();
  return summary ? summary.slice(0, 1200) : null;
}

export function updateMissionMemorySidecar(mdPath: string, candidateId: string): void {
  const safeMarkdownPath = assertSafeRepositoryPath(mdPath, { allowMissingLeaf: true });
  const sidecarPath = volatileSidecarPath(safeMarkdownPath);
  if (!safeExistsSync(sidecarPath)) return;
  if (!safeStat(sidecarPath).isFile()) {
    throw new Error(`Volatile knowledge sidecar must be a regular file: ${sidecarPath}`);
  }
  const sidecar = loadVolatileSidecarAtPath(sidecarPath);
  if (!sidecar) throw new Error(`Invalid volatile knowledge sidecar at ${sidecarPath}`);
  saveVolatileSidecarAtPath(sidecarPath, {
    ...sidecar,
    promotion_candidate_id: candidateId,
    status: 'promoted',
    updated_at: nowIso(),
  });
}

export function readMissionNextTasks(missionDir: string): Array<Record<string, unknown>> {
  const nextTasksPath = safeMissionPath(missionDir, 'NEXT_TASKS.json', true);
  if (!safeExistsSync(nextTasksPath)) return [];
  try {
    return (
      loadMissionNextTaskObjectsAtPath(
        nextTasksPath,
        path.basename(safeMissionDir(missionDir, true))
      ) || []
    );
  } catch {
    return [];
  }
}

export function writeMissionNextTasks(
  missionDir: string,
  tasks: Array<Record<string, unknown>>
): void {
  const nextTasksPath = safeMissionPath(missionDir, 'NEXT_TASKS.json', true);
  const validated = validateMissionNextTaskObjects(tasks, nextTasksPath);
  safeWriteFile(nextTasksPath, JSON.stringify(validated, null, 2));
}

export const MISSION_TASK_COMPLETED_STATUSES = new Set([
  'done',
  'completed',
  'accepted',
  'reviewed',
]);

/**
 * A review-kind task — identified the same way `mission-process-task-expansion.ts`
 * and `mission-governance.ts`'s artifact-review gate independently do, ORed
 * together since neither alone is authoritative across every task origin
 * (process-template expansion always sets `phase_kind`; hand-authored /
 * dispatched tasks may only set `assigned_to.role` or `review_target`).
 */
function isReviewKindTask(task: Record<string, unknown>): boolean {
  if (task.phase_kind === 'review') return true;
  const role = String((task.assigned_to as { role?: string } | undefined)?.role || '')
    .trim()
    .toLowerCase();
  if (role === 'reviewer' || role === 'qa') return true;
  return typeof task.review_target === 'string' && task.review_target.length > 0;
}

/**
 * Review-kind tasks require a real `ArtifactReviewReceipt` (see
 * `recordArtifactReview` in `mission-maintenance.ts`), not bare file
 * existence — a file merely existing at the expected review path proves
 * nothing about whether a review actually happened, let alone by the right
 * team composition. This closes exactly the gap an adversarial review of
 * this mission's own process found: `echo '# review' > REVIEW-x.md` +
 * plain `record-evidence` previously satisfied a review task with zero
 * review having occurred.
 *
 * Independence defaults to REQUIRED even when no `artifact_review_profile`
 * is set (fail-safe): a review task with no profile at all has not been
 * through `recordArtifactReview`, so it has no receipt either and this
 * returns false regardless.
 */
function isReviewTaskSatisfied(missionDir: string, task: Record<string, unknown>): boolean {
  const receiptRef = String(task.artifact_review_receipt || '').trim();
  if (!receiptRef) return false;
  let receiptPath: string;
  try {
    receiptPath = safeMissionPath(missionDir, receiptRef);
  } catch {
    return false;
  }
  if (!safeExistsSync(receiptPath)) return false;

  try {
    const receipt = loadArtifactReviewReceipt(receiptPath);
    const reviewTargetId = String(task.review_target || '');
    if (reviewTargetId && receipt.review_target_task_id !== reviewTargetId) return false;

    // receipt.artifact.path is repo-root-relative (matches
    // validateMissionArtifactReviewGate's pathResolver.rootResolve and
    // mission-governance.test.ts's convention), not mission-relative.
    const artifactPath = assertSafeRepositoryPath(pathResolver.rootResolve(receipt.artifact.path));
    if (!safeExistsSync(artifactPath)) return false;
    const currentSha256 = hashArtifactForReview(artifactPath);

    const profile = task.artifact_review_profile as
      | {
          implementer_agent_ids?: string[];
          independence_required?: boolean;
          required_reviewer_roles?: string[];
        }
      | undefined;

    const evaluation = evaluateArtifactReviews({
      artifacts: [
        { path: receipt.artifact.path, sha256: currentSha256, kind: receipt.artifact.kind },
      ],
      reviews: [receiptToArtifactReviewDecision(receipt)],
      requiredReviewerRoles: profile?.required_reviewer_roles || [],
      implementerAgentIds: profile?.implementer_agent_ids || [],
      requireIndependence: profile?.independence_required !== false,
    });
    return evaluation.ready;
  } catch {
    return false;
  }
}

/**
 * A task is auto-completable once its own deliverable file exists AND every
 * dependency it lists is already in a completed status. This is the same
 * bar `evaluateMissionFinishExitGate` already trusts for `repair-`/`goal-gap-`
 * tasks; `tryAutoCompleteTaskFromEvidence` below applies it more generally,
 * gated on an explicit `record-evidence` call rather than bare file presence
 * at finish-time — the explicit, task_id-scoped act of recording evidence is
 * what makes trusting a deliverable-exists check safe for a normal task.
 *
 * Review-kind tasks are held to a strictly higher bar (see
 * `isReviewTaskSatisfied`): deliverable existence is necessary but not
 * sufficient for them.
 */
export function isTaskDeliverableSatisfied(
  missionDir: string,
  task: Record<string, unknown>,
  statusByTaskId: Map<string, string>
): boolean {
  const taskId = String(task.task_id || '');
  const dependencies = Array.isArray(task.dependencies)
    ? task.dependencies
        .map((dependency) => String(dependency))
        .filter((dependency) => dependency !== taskId)
    : [];
  const deliverable = String(task.deliverable || task.target_path || '');
  const dependenciesComplete = dependencies.every((dependency) =>
    MISSION_TASK_COMPLETED_STATUSES.has(statusByTaskId.get(dependency) || 'planned')
  );
  let deliverablePath: string | null = null;
  if (deliverable.length > 0) {
    try {
      deliverablePath = safeMissionPath(missionDir, deliverable);
    } catch {
      deliverablePath = null;
    }
  }
  const deliverableExists = Boolean(deliverablePath && safeExistsSync(deliverablePath));
  if (!dependenciesComplete || !deliverableExists) return false;
  if (isReviewKindTask(task)) return isReviewTaskSatisfied(missionDir, task);
  return true;
}

/**
 * Called from `record-evidence` (see `mission-maintenance.ts`) so the flow
 * `execution.md` already documents — checkpoint + record-evidence per task —
 * actually closes the task out in `NEXT_TASKS.json`, instead of only
 * appending to the execution ledger and leaving `finish` to fail with
 * "Pending tasks remain" until the agent separately discovers `reconcile-work`.
 * No-ops (returns `completed: false`) when the task is unknown, already
 * completed, or its deliverable/dependencies aren't actually satisfied yet —
 * recording evidence for a task never rubber-stamps a task whose deliverable
 * doesn't exist.
 */
export function tryAutoCompleteTaskFromEvidence(
  missionDir: string,
  taskId: string
): { completed: boolean; reason: string } {
  const nextTasks = readMissionNextTasks(missionDir);
  const statusByTaskId = new Map(
    nextTasks.map((task) => [
      String(task.task_id || ''),
      String(task.status || 'planned').toLowerCase(),
    ])
  );
  const task = nextTasks.find((entry) => String(entry.task_id || '') === taskId);
  if (!task) return { completed: false, reason: 'task not found in NEXT_TASKS.json' };

  const currentStatus = String(task.status || 'planned').toLowerCase();
  if (MISSION_TASK_COMPLETED_STATUSES.has(currentStatus)) {
    return { completed: false, reason: 'already completed' };
  }
  if (!isTaskDeliverableSatisfied(missionDir, task, statusByTaskId)) {
    return {
      completed: false,
      reason: 'deliverable file missing or a dependency is not yet completed',
    };
  }

  task.status = 'completed';
  writeMissionNextTasks(missionDir, nextTasks);
  return { completed: true, reason: 'deliverable present and dependencies satisfied' };
}

/**
 * Goal Satisfaction Loop: when finish-time reconciliation says the mission
 * does NOT yet satisfy the user's actual goal, convert the concrete gaps into
 * implementer+reviewer tasks and hand the mission back to the orchestration
 * worker — the ⑤→④ back-edge that turns "report the gap" into "close the
 * gap". Bounded by KYBERION_GOAL_LOOP_MAX_ROUNDS (default 2); exhaustion
 * escalates to the operator through the standard finish-gate failure path.
 */
export function upsertGoalGapTasks(input: {
  missionDir: string;
  round: number;
  gaps: string[];
  goal: { summary: string; success_condition: string };
}): string[] {
  const tasks = readMissionNextTasks(input.missionDir);
  const created: string[] = [];
  const upserted: Record<string, unknown>[] = [];
  input.gaps.slice(0, 3).forEach((gap, index) => {
    const gapText = String(gap || '').trim() || 'unresolved goal gap';
    const taskId = `goal-gap-r${input.round}-${index + 1}`;
    const reviewTaskId = `${taskId}-review`;
    upserted.push({
      task_id: taskId,
      status: 'planned',
      assigned_to: { role: 'implementer' },
      description: `Close this gap between the delivered evidence and the user's goal: ${gapText}`,
      deliverable: `evidence/${taskId}.md`,
      target_path: `evidence/${taskId}.md`,
      dependencies: [],
      acceptance_criteria: [
        gapText,
        `Advances the mission goal: ${input.goal.summary}`,
        `Success condition: ${input.goal.success_condition}`,
      ],
      risk: 'medium',
      expected_output_format: 'files',
      estimated_scope: 'M',
    });
    upserted.push({
      task_id: reviewTaskId,
      status: 'planned',
      assigned_to: { role: 'reviewer' },
      description: `Review whether ${taskId} actually closes the goal gap (not just addresses the wording): ${gapText}`,
      deliverable: `evidence/REVIEW-${taskId}.md`,
      dependencies: [taskId],
      review_target: taskId,
      acceptance_criteria: [`The gap is verifiably closed with evidence: ${gapText}`],
      risk: 'medium',
      expected_output_format: 'files',
      estimated_scope: 'S',
    });
    created.push(taskId, reviewTaskId);
  });
  const createdIds = new Set(created);
  const filtered = tasks.filter((task) => !createdIds.has(String(task.task_id || '')));
  writeMissionNextTasks(input.missionDir, [...filtered, ...upserted]);
  return created;
}

export function upsertMissionGateRepairTask(input: {
  missionDir: string;
  gateId: string;
  reason: string;
  pendingTasks: string[];
}): string[] {
  const tasks = readMissionNextTasks(input.missionDir);
  const repairTaskId = `repair-${input.gateId}`;
  const repairTask = {
    task_id: repairTaskId,
    status: 'planned',
    assigned_to: {
      role: 'operator',
      agent_id: 'mission_controller',
    },
    description: `Repair mission ${input.gateId} gate failure: ${input.reason}`,
    deliverable: `evidence/${repairTaskId}.md`,
    target_path: `evidence/${repairTaskId}.md`,
    dependencies: input.pendingTasks.filter((taskId) => taskId !== repairTaskId),
    acceptance_criteria: [
      `Resolve ${input.gateId} gate issue: ${input.reason}`,
      'Update mission evidence and task board to reflect the repaired gate state.',
    ],
    risk: 'medium',
    expected_output_format: 'files',
    estimated_scope: 'M',
  };
  const filtered = tasks.filter((task) => String(task.task_id || '') !== repairTaskId);
  filtered.unshift(repairTask as Record<string, unknown>);
  writeMissionNextTasks(input.missionDir, filtered);
  return [repairTaskId];
}
