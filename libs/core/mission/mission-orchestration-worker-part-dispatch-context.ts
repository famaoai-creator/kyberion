import type { MissionTeamAssignment } from './mission-team-plan-composer.js';
/**
 * Neutral context and trace seams shared by the mission worker dispatch paths.
 * This module deliberately has no dependency on the dispatch wrapper, so the
 * worker core can depend on it without recreating a static/dynamic cycle.
 */
import { missionCoordinationBus } from './mission-coordination-bus.js';
import { logger } from '../core.js';
import { buildWorkingPrinciplesLines, canonicalizeTeamRole } from '../working-principles.js';
import {
  buildWorkingPrinciplesInjectionProvider,
  getMissionDynamicInjectionRegistry,
  renderInjectionsAsSystemReminders,
} from '../dynamic-injection.js';
import { pathResolver } from '../path-resolver.js';
import { type MissionContextPackPruningSummary } from './mission-context-pack.js';
import { provisionTaskKnowledge } from '../task/task-knowledge-provisioning.js';
import { type DeliveredKnowledgeRef } from '../knowledge/knowledge-feedback-loop.js';
import { TraceContext } from '../analysis/trace.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { nowIso } from '../foundation/time.js';
import { assertSafeRepositoryPath } from '../secure-io.js';
import { loadMissionStateSnapshot } from './mission-orchestration-phase-gates.js';
import {
  evaluateContextFragment,
  resolveTenantAlias,
  type ContextSecurityScope,
} from '../context-security-scope.js';
import type { ConfidentialTaskDecisionValues } from '../customer-decision/task-decision-values.js';
import {
  buildArtifactReviewLines,
  prepareArtifactReviewTask,
} from './mission-orchestration-artifact-review.js';
export { resolveMissionPlanningPacket } from './mission-orchestration-planning.js';

export {
  evaluateMissionPhaseExitGates,
  loadMissionPhaseGateDefinitions,
  resolvePhaseGateMode,
} from './mission-orchestration-phase-gates.js';
import { type MissionGraphHandoff } from './mission-graph-handoff.js';
import { DELEGATION_NOTIFICATION_CLAIM_LIMIT } from './delegation-notifications.js';
import {
  type PlannedNextTask,
  type TaskResultBlock,
} from './mission-orchestration-worker-contracts.js';

import {
  buildUpstreamResultLines,
  buildGraphHandoffLines,
  buildTeamSnapshotLines,
  buildReviewFindingsLines,
  buildDelegationNotificationLines,
  maybeCompactDispatchSections,
  buildMissionGoalLines,
  buildRejectionLessonLines,
  buildAuthorityRoleProcedureInjectionProvider,
  buildTaskExecutionPrompt,
  buildReviewDiffLines,
  resolvedMissionDir,
} from './mission-orchestration-worker-part-context.js';
import type { DispatchMissionTaskOutcome } from './mission-orchestration-worker-part-context.js';

export interface DispatchPlannedMissionTaskInput {
  missionId: string;
  task: PlannedNextTask;
  /** Explicit mission-resume ceremony; never inferred from a normal dispatch. */
  resumeGoalDriven?: boolean;
  teamRole: string;
  assignment: {
    agent_id: string;
    authority_role?: string | null;
    model_hint?: { model_id?: string; tier?: string; effort?: string; route_reason?: string };
    organization_role_id?: string;
    perspective_ids?: string[];
    reasoning_route_id?: string;
    selection_reason_codes?: string[];
    provider?: string | null;
    modelId?: string | null;
    requested_selection?: MissionTeamAssignment['requested_selection'];
    selection_resolution?: MissionTeamAssignment['selection_resolution'];
    required_capabilities?: MissionTeamAssignment['required_capabilities'];
  };
  allTasks: PlannedNextTask[];
  upstreamHandoffs?: Array<MissionGraphHandoff<DispatchMissionTaskOutcome, TaskResultBlock>>;
  queuedInputPrompt?: string;
  iterationPolicy: {
    max_rework_attempts: number;
    max_review_rounds: number;
  };
}

/** Blocked reason of a task whose confirmed customer decisions may not reach its prompt. */
export const CUSTOMER_DECISION_TIER_MISMATCH = 'customer_decision_tier_mismatch';

/**
 * CD-09 tier gate (human decision 2026-10-25): a resumed task's confirmed
 * customer decisions are confidential data of the case's tenant. They reach
 * the prompt only when the mission's context pack may carry that tenant's
 * confidential data: a pack is present (not the degraded fallback), it
 * writes the confidential tier, denies external egress, is scoped to the
 * case's tenant, and admits a confidential fragment of that tenant / mission
 * / project (`evaluateContextFragment`). Otherwise the values are withheld
 * and the caller blocks the task. Returns the withhold reason (ids-safe), or
 * null when the values may be delivered.
 */
export function customerDecisionTierGate(input: {
  securityScope: ContextSecurityScope | undefined;
  missionId: string;
  tenantSlug: string;
  caseId: string;
  projectId?: string;
}): string | null {
  const scope = input.securityScope;
  if (!scope) return 'context_pack_unavailable';
  if (scope.write_tier !== 'confidential') return `mission_tier_${scope.write_tier}`;
  if (scope.external_egress !== 'deny') return 'external_egress_not_denied';
  if (resolveTenantAlias(scope) !== input.tenantSlug) return 'tenant_scope_mismatch';
  const rejection = evaluateContextFragment(scope, {
    fragment_id: `customer-decision:${input.caseId}`,
    source_ref: `customer-decision:${input.caseId}`,
    source_tier: 'confidential',
    tenant_slug: input.tenantSlug,
    mission_id: input.missionId,
    ...(input.projectId ? { project_id: input.projectId } : {}),
    content: null,
  });
  return rejection ? rejection.code.toLowerCase() : null;
}

/** What became of a resumed task's confirmed customer decisions in this dispatch (ids only). */
export interface CustomerDecisionDelivery {
  status: 'delivered' | 'withheld';
  reason?: string;
  decision_ids: string[];
}

export async function buildTaskDispatchContext(input: {
  missionId: string;
  task: PlannedNextTask;
  teamRole: string;
  agentId: string;
  authorityRole?: string | null;
  taskModelHint?: { model_id?: string; tier?: string; effort?: string; route_reason?: string };
  allTasks: PlannedNextTask[];
  upstreamHandoffs?: Array<MissionGraphHandoff<DispatchMissionTaskOutcome, TaskResultBlock>>;
  /** OH-01 reactive path: force compaction after a prompt-too-long dispatch failure. */
  forceContextCompaction?: boolean;
  /** CD-09: a resumed task's confirmed customer decisions (from the decision pin). */
  customerDecisionValues?: ConfidentialTaskDecisionValues;
}): Promise<{
  prompt: string;
  missionContextPackId?: string;
  missionContextPackPath?: string;
  missionContextPackSummary: string;
  missionContextPackPruningSummary?: MissionContextPackPruningSummary;
  securityScope?: import('../context-security-scope.js').ContextSecurityScope;
  /** KP-05: knowledge actually delivered as part of this dispatch's context pack. */
  deliveredKnowledgeRefs: DeliveredKnowledgeRef[];
  /** CD-09: present when the task had confirmed customer decisions to receive. */
  customerDecisionDelivery?: CustomerDecisionDelivery;
}> {
  const missionStateRaw = loadMissionStateSnapshot(input.missionId);
  const missionState =
    missionStateRaw && typeof missionStateRaw === 'object'
      ? missionStateRaw
      : {
          mission_id: input.missionId,
          tier: 'public',
          status: 'active',
          assigned_persona: 'worker',
          git: {
            branch: 'main',
            start_commit: '',
            latest_commit: '',
            checkpoints: [],
          },
          history: [],
          relationships: {},
        };
  // KP-01: single provisioning entry point (resolve + persist + render) —
  // `form: 'pack'` reproduces the pre-KP-01 inline resolve/save/render
  // sequence byte-for-byte.
  const missionTier = (missionState.tier as 'personal' | 'confidential' | 'public') || 'public';
  const missionTenantSlug =
    typeof (missionState as Record<string, unknown>).tenant_slug === 'string'
      ? String((missionState as Record<string, unknown>).tenant_slug)
      : undefined;
  const workItemTimestamp = nowIso();
  const provisionedContext = await provisionTaskKnowledge({
    form: 'pack',
    missionPath: resolvedMissionDir(input.missionId, missionTier, missionTenantSlug),
    missionId: input.missionId,
    tier: missionTier,
    recipientKind: 'agent',
    teamRole: input.teamRole,
    assigneePeerId: input.agentId,
    // KP-04: hint count + pack char budget scale with the task's declared
    // scope (SCOPE_KNOWLEDGE_BUDGETS in mission-context-pack.ts). Absent
    // scope falls back to `M`, so untagged tasks are unaffected.
    ...(input.task.estimated_scope ? { estimatedScope: input.task.estimated_scope } : {}),
    workItem: {
      item_id: input.task.task_id,
      title: input.task.description || input.task.task_id,
      description: input.task.description || input.task.task_id,
      status: 'ready',
      priority: 'normal',
      source: 'local',
      source_ref: `mission:${input.missionId}:${input.task.task_id}`,
      project_id: String(
        (missionState.relationships as any)?.project?.project_id || input.missionId
      ),
      labels: [`mission:${input.missionId}`, `team_role:${input.teamRole}`],
      dependencies: Array.isArray((input.task as any).dependencies)
        ? (input.task as any).dependencies
        : [],
      version: 1,
      created_at: workItemTimestamp,
      updated_at: workItemTimestamp,
      metadata: {
        deliverable: input.task.deliverable,
        target_path: input.task.target_path,
        acceptance_criteria: (input.task as any).acceptance_criteria,
        risk: (input.task as any).risk,
        estimated_scope: (input.task as any).estimated_scope,
      },
    },
  });
  const missionContextPack = provisionedContext.pack;
  const missionContextPackPath = provisionedContext.missionContextPackPath;
  const missionContextPackText = missionContextPack
    ? provisionedContext.text
    : [
        'Mission context pack unavailable; using degraded fallback context.',
        `- Mission: ${input.missionId}`,
        `- Task: ${input.task.task_id}`,
        input.teamRole ? `- Team role: ${input.teamRole}` : '',
        input.task.description ? `- Description: ${input.task.description}` : '',
      ]
        .filter(Boolean)
        .join('\n');
  const missionGoalLines = buildMissionGoalLines(missionState);
  const compactedSections = await maybeCompactDispatchSections({
    missionId: input.missionId,
    task: input.task,
    allTasks: input.allTasks,
    agentId: input.agentId,
    missionContextPackText,
    missionGoalLines,
    upstreamResultLines: [
      ...buildGraphHandoffLines(input.upstreamHandoffs || []),
      ...buildUpstreamResultLines(input.task, input.allTasks),
      ...buildReviewDiffLines(input.missionId, input.task),
    ],
    teamSnapshotLines: buildTeamSnapshotLines(input.allTasks),
    securityScope: missionContextPack?.security_scope,
    force: input.forceContextCompaction,
    ...(input.forceContextCompaction ? { reason: 'overflow' as const } : {}),
  });
  const upstreamResultLines = compactedSections.upstreamResultLines;
  const teamSnapshotLines = compactedSections.teamSnapshotLines;
  const reviewFindingsLines = buildReviewFindingsLines(input.task);
  const canonicalTeamRole = canonicalizeTeamRole(input.teamRole);
  if (canonicalTeamRole === 'reviewer' || canonicalTeamRole === 'qa') {
    prepareArtifactReviewTask({
      missionId: input.missionId,
      reviewTask: input.task,
      tasks: input.allTasks,
    });
    try {
      missionCoordinationBus.send({
        mission_id: input.missionId,
        channel: 'review',
        from_agent: 'mission_orchestration_worker',
        to_agent: input.agentId,
        to_role: canonicalTeamRole,
        task_id: input.task.task_id,
        content: `Artifact review requested for task ${input.task.task_id}.`,
      });
    } catch {
      // Coordination-bus visibility is best-effort; never block dispatch on it.
    }
  }
  const artifactReviewLines = buildArtifactReviewLines(input.task);
  const rejectionLessonLines = buildRejectionLessonLines();
  // KC-06: deliver claimed background-delegation completions into this dispatch.
  const delegationNotificationLines = buildDelegationNotificationLines(
    DELEGATION_NOTIFICATION_CLAIM_LIMIT,
    { missionId: input.missionId, taskId: input.task.task_id }
  );
  // KC-08: all runtime prompt injections pass through the provider contract.
  // This keeps one-shot/throttle semantics testable and leaves room for repeat
  // warnings and claimed notifications to join the same registry.
  const injectionRegistry = getMissionDynamicInjectionRegistry(input.missionId);
  if (!injectionRegistry.hasProvider('working-principles')) {
    injectionRegistry.register(
      buildWorkingPrinciplesInjectionProvider(buildWorkingPrinciplesLines, input.teamRole)
    );
  }
  if (input.authorityRole) {
    const authorityRoleProviderId = `authority-role-procedure:${input.authorityRole}`;
    if (!injectionRegistry.hasProvider(authorityRoleProviderId)) {
      injectionRegistry.register(buildAuthorityRoleProcedureInjectionProvider(input.authorityRole));
    }
  }
  const dynamicInjectionLines = injectionRegistry
    .collect({ step: 0 })
    .map((injection) => renderInjectionsAsSystemReminders([injection]));
  const promptSupplementChars =
    upstreamResultLines.join('\n').length +
    teamSnapshotLines.join('\n').length +
    reviewFindingsLines.join('\n').length +
    artifactReviewLines.join('\n').length +
    rejectionLessonLines.join('\n').length +
    delegationNotificationLines.join('\n').length +
    dynamicInjectionLines.join('\n').length +
    256;
  // CD-09: the values go into the prompt only past the tier gate; they are
  // never passed to the compaction step or into any other section.
  const decisionValues =
    input.customerDecisionValues && input.customerDecisionValues.count > 0
      ? input.customerDecisionValues
      : undefined;
  const decisionWithheld = decisionValues
    ? customerDecisionTierGate({
        securityScope: missionContextPack ? missionContextPack.security_scope : undefined,
        missionId: String(missionState.mission_id || input.missionId),
        tenantSlug: decisionValues.tenantSlug,
        caseId: decisionValues.caseId,
        ...(decisionValues.projectId ? { projectId: decisionValues.projectId } : {}),
      })
    : null;
  const customerDecisionDelivery: CustomerDecisionDelivery | undefined = decisionValues
    ? {
        status: decisionWithheld ? 'withheld' : 'delivered',
        ...(decisionWithheld ? { reason: decisionWithheld } : {}),
        decision_ids: decisionValues.decisionIds,
      }
    : undefined;
  if (decisionValues && decisionWithheld) {
    logger.warn(
      `customer decisions withheld from task ${input.task.task_id} — the mission context may not carry tenant ${decisionValues.tenantSlug}'s confidential data (${decisionWithheld}) | the task is blocked (${CUSTOMER_DECISION_TIER_MISMATCH}); run it in a confidential mission of that tenant | mission=${input.missionId} consumer=${decisionValues.consumer} decisions=${decisionValues.decisionIds.join(',')}`
    );
  }
  const prompt = buildTaskExecutionPrompt({
    missionId: input.missionId,
    tenantSlug: missionTenantSlug,
    task: input.task,
    teamRole: input.teamRole,
    agentId: input.agentId,
    taskModelHint: input.taskModelHint,
    rejectionLessonLines,
    delegationNotificationLines,
    dynamicInjectionLines,
    missionContextPack: missionContextPackText,
    missionGoalLines,
    upstreamResultLines,
    teamSnapshotLines,
    reviewFindingsLines,
    artifactReviewLines,
    targetPath: input.task.target_path || input.task.deliverable,
    ...(decisionValues && !decisionWithheld
      ? { customerDecisionLines: decisionValues.promptLines() }
      : {}),
  });
  const missionContextPackPruningSummary = missionContextPack?.pruning
    ? {
        ...(missionContextPack.pruning as MissionContextPackPruningSummary),
        estimated_chars:
          (missionContextPack.pruning as MissionContextPackPruningSummary).estimated_chars +
          promptSupplementChars,
      }
    : undefined;
  return {
    prompt,
    missionContextPackId: missionContextPack?.context_pack_id,
    missionContextPackPath,
    missionContextPackSummary: missionContextPack?.summary || 'degraded mission context pack',
    missionContextPackPruningSummary,
    securityScope: missionContextPack?.security_scope,
    deliveredKnowledgeRefs: provisionedContext.deliveredKnowledgeRefs,
    ...(customerDecisionDelivery ? { customerDecisionDelivery } : {}),
  };
}

// MO-03 Task 2.3: per-task wall-clock budget derived from estimated_scope.
// A hung dispatch must not stall the whole wave silently — on timeout the
// task is marked blocked(timeout) and downstream dependents cascade to
export let warnedMissionTaskTraceFailureOnce = false;

export function missionTaskTraceDirOverride(): string | undefined {
  const override = getRegisteredEnvText('KYBERION_MISSION_TASK_TRACE_DIR')?.trim();
  if (!override) return undefined;
  try {
    return assertSafeRepositoryPath(pathResolver.rootResolve(override), {
      allowMissingLeaf: true,
    });
  } catch (error) {
    logger.warn(
      `[MISSION_WORKER][KP-05] ignoring unsafe trace directory override: ${String(error)}`
    );
    return undefined;
  }
}

export function warnMissionTaskTraceFailureOnce(context: string, error: unknown): void {
  if (warnedMissionTaskTraceFailureOnce) return;
  warnedMissionTaskTraceFailureOnce = true;
  const message = error instanceof Error ? error.message : String(error);
  logger.warn(`[MISSION_WORKER][KP-05] ${context}: ${message}`);
}

/**
 * Attach delivered knowledge to the current dispatch trace span. `knowledgeRefs`
 * (the trace schema field, `src/trace.ts`) is `string[]` — paths only — so
 * paths go there; per-ref scores ride along on a companion event's
 * attributes (`TraceEvent.attributes` already supports arbitrary
 * string/number/boolean values, unlike `knowledgeRefs` which every consumer,
 * e.g. chronos-mirror-v2's TraceViewer, expects to stay a plain string array).
 * Never throws — a tracing failure must never affect dispatch.
 */
export function attachDeliveredKnowledgeRefs(
  traceCtx: TraceContext,
  refs: DeliveredKnowledgeRef[] | undefined
): void {
  if (!refs || refs.length === 0) return;
  try {
    for (const ref of refs) traceCtx.addKnowledgeRef(ref.path);
    traceCtx.addEvent('knowledge_delivered', {
      knowledge_ref_count: refs.length,
      knowledge_refs_scored: JSON.stringify(
        refs.map((ref) => ({ path: ref.path, score: ref.score ?? null }))
      ),
    });
  } catch (err: any) {
    warnMissionTaskTraceFailureOnce(
      `Failed to attach delivered knowledge refs to mission task trace`,
      err
    );
  }
}
