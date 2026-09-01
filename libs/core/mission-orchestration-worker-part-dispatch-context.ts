/**
 * Neutral context and trace seams shared by the mission worker dispatch paths.
 * This module deliberately has no dependency on the dispatch wrapper, so the
 * worker core can depend on it without recreating a static/dynamic cycle.
 */
import { missionCoordinationBus } from './mission-coordination-bus.js';
import { logger } from './core.js';
import { buildWorkingPrinciplesLines, canonicalizeTeamRole } from './working-principles.js';
import {
  buildWorkingPrinciplesInjectionProvider,
  getMissionDynamicInjectionRegistry,
  renderInjectionsAsSystemReminders,
} from './dynamic-injection.js';
import { findMissionPath, missionDir } from './path-resolver.js';
import { pathResolver } from './path-resolver.js';
import { type MissionContextPackPruningSummary } from './mission-context-pack.js';
import { provisionTaskKnowledge } from './task-knowledge-provisioning.js';
import { type DeliveredKnowledgeRef } from './src/knowledge-feedback-loop.js';
import { TraceContext } from './src/trace.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { assertSafeRepositoryPath } from './secure-io.js';
import { loadMissionStateSnapshot } from './mission-orchestration-phase-gates.js';
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
} from './mission-orchestration-worker-part-context.js';
import type { DispatchMissionTaskOutcome } from './mission-orchestration-worker-part-context.js';

function resolvedMissionDir(
  missionId: string,
  fallbackTier: 'personal' | 'confidential' | 'public' = 'public',
  tenantSlug?: string
): string {
  return tenantSlug?.trim()
    ? missionDir(missionId, fallbackTier, tenantSlug.trim())
    : findMissionPath(missionId) || missionDir(missionId, fallbackTier);
}

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
  };
  allTasks: PlannedNextTask[];
  upstreamHandoffs?: Array<MissionGraphHandoff<DispatchMissionTaskOutcome, TaskResultBlock>>;
  queuedInputPrompt?: string;
  iterationPolicy: {
    max_rework_attempts: number;
    max_review_rounds: number;
  };
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
}): Promise<{
  prompt: string;
  missionContextPackId?: string;
  missionContextPackPath?: string;
  missionContextPackSummary: string;
  missionContextPackPruningSummary?: MissionContextPackPruningSummary;
  securityScope?: import('./context-security-scope.js').ContextSecurityScope;
  /** KP-05: knowledge actually delivered as part of this dispatch's context pack. */
  deliveredKnowledgeRefs: DeliveredKnowledgeRef[];
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
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
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
