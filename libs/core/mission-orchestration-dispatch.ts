import { buildExecutionEnv } from './authority.js';
import { findMissionPath, missionDir } from './path-resolver.js';
import { safeExistsSync } from './secure-io.js';
import { logger } from './core.js';
import { ensureMissionTeamRuntimeViaSupervisor } from './agent-runtime-supervisor.js';
import {
  resolveMissionTeamPlan,
  resolveMissionTeamReceiver,
} from './mission-team-plan-composer.js';
import { resolveTaskModelHint } from './reasoning-model-routing.js';
import { type TaskModelPhaseKind } from './reasoning-level-policy.js';
import { emitMissionTaskEvent } from './mission-task-events.js';
import { emitMissionOrchestrationObservation } from './mission-orchestration-events.js';
import { inferTaskTargetPath, validateDelegatedTaskPreflight } from './delegation-preflight.js';
import { resolveMissionRelativeTargetPath } from './mission-orchestration-planning.js';
import {
  prepareArtifactReviewTask,
  resolveReviewTargetForTask,
} from './mission-orchestration-artifact-review.js';
import { deriveExecutionGraph, executeGraph, type GraphNode } from './graph-scheduler.js';
import {
  buildMissionGraphInputs,
  collectMissionGraphHandoffs,
  type MissionGraphHandoff,
} from './mission-graph-handoff.js';
import { openOrCreateMissionGraphRunJournal } from './mission-graph-run-journal.js';
import { ledger } from './ledger.js';
import { TraceContext } from './src/trace.js';
import type { PlannedNextTask, TaskResultBlock } from './mission-orchestration-worker-contracts.js';
import type { DispatchMissionTaskOutcome } from './mission-orchestration-worker.js';

const MISSION_CONTROLLER_TIMEOUT_MS = 600_000;

type AnyCallback = (...args: unknown[]) => unknown;

export interface DispatchCoreDeps {
  ensureWorkerBackendsInstalled: () => void;
  loadAllNextTasks: (missionId: string) => PlannedNextTask[];
  restoreMissionGraphRunTaskSnapshots: AnyCallback;
  writeNextTasks: (missionId: string, tasks: PlannedNextTask[]) => void;
  reconcileMissionProgress: (missionId: string) => void;
  runMissionController: AnyCallback;
  recordMissionContextTask: AnyCallback;
  resolveTaskDispatchTimeoutMs: (task: PlannedNextTask) => number;
  withTaskDispatchTimeout: AnyCallback;
  dispatchPlannedMissionTask: AnyCallback;
  isGoalDrivenTaskResumable: (missionId: string, task: PlannedNextTask) => boolean;
  loadPlannedNextTasks: (missionId: string) => PlannedNextTask[];
  buildUnassignedRoleSummary: (task: PlannedNextTask, teamRole?: string) => string;
  cascadeBlockedDependents: (tasks: PlannedNextTask[]) => string[];
  markTaskBoardInProgress: (missionId: string) => void;
}

export async function dispatchMissionNextTasksCore(
  deps: DispatchCoreDeps,

  missionId: string,
  missionRunTrace?: TraceContext,
  graphRunId?: string,
  options: { resumeGoalDriven?: boolean } = {}
): Promise<Array<{ task_id: string; team_role: string; agent_id: string }>> {
  deps.ensureWorkerBackendsInstalled();
  // A mission may live under personal/confidential or a tenant overlay. The
  // recovery ceremony must inspect the same resolved mission root as the
  // progress controller; a public-only probe would silently turn a valid
  // paused goal into a no-op.
  const resolvedMissionPath = findMissionPath(missionId) || missionDir(missionId, 'public');
  const nextTasksPath = `${resolvedMissionPath}/NEXT_TASKS.json`;
  if (!safeExistsSync(nextTasksPath)) return [];
  const allTasks = deps.loadAllNextTasks(missionId);
  const resumeGoalDriven = options.resumeGoalDriven === true;
  let plannedTasks = allTasks.filter((task) => {
    const status = String(task.status || 'planned');
    if (status !== 'planned' && status !== 'rework') return false;
    return !resumeGoalDriven || deps.isGoalDrivenTaskResumable(missionId, task);
  });
  if (plannedTasks.length === 0) return [];

  const runId = graphRunId?.trim() || `manual-${Date.now()}`;
  const graphRunJournal = openOrCreateMissionGraphRunJournal({
    missionId,
    runId,
    taskIds: allTasks.map((task) => task.task_id),
  });
  deps.restoreMissionGraphRunTaskSnapshots(allTasks, graphRunJournal);
  plannedTasks = allTasks.filter((task) => {
    const status = String(task.status || 'planned');
    if (status !== 'planned' && status !== 'rework') return false;
    return !resumeGoalDriven || deps.isGoalDrivenTaskResumable(missionId, task);
  });
  if (plannedTasks.length === 0) {
    deps.writeNextTasks(missionId, allTasks);
    graphRunJournal.append('graph_finished', { status: 'completed', recovered_only: true });
    deps.reconcileMissionProgress(missionId);
    return [];
  }

  const uniqueRoles = Array.from(
    new Set(
      plannedTasks
        .map((task) => task.assigned_to?.role)
        .filter((role): role is string => Boolean(role))
    )
  );
  if (uniqueRoles.length > 0) {
    await ensureMissionTeamRuntimeViaSupervisor({
      missionId,
      teamRoles: uniqueRoles,
      requestedBy: 'mission_orchestration_worker',
      reason: 'Prewarm roles required by planner-produced NEXT_TASKS.',
      timeoutMs: MISSION_CONTROLLER_TIMEOUT_MS,
    });
  }

  const dispatched: Array<{ task_id: string; team_role: string; agent_id: string }> = [];
  const dispatchObservability: Array<{
    dispatched: boolean;
    context_chars?: number;
    pruned_chars?: number;
    rollup_used: boolean;
    result_schema_ok: boolean;
    needs_count: number;
  }> = [];
  const plan = resolveMissionTeamPlan({ missionId });
  const maxParallelMembers = Math.max(1, plan.team_governance?.lifecycle.max_parallel_members || 3);
  const lifecycle = plan.team_governance?.lifecycle;
  const maxFollowupIterations = Math.max(1, lifecycle?.max_followup_iterations || 20);
  const iterationPolicy = {
    max_rework_attempts: Math.max(1, lifecycle?.max_rework_attempts || 1),
    max_review_rounds: Math.max(1, lifecycle?.max_review_rounds || 2),
  };
  const dispatchedTaskIds = new Set<string>();
  let followupIterations = 0;

  while (true) {
    // The graph owns dependency readiness. The worker prepares every planned
    // node once so a completed predecessor can activate its successor in the
    // same graph run instead of waiting for this outer loop to rescan state.
    const graphTasks = plannedTasks
      .filter(
        (task) =>
          (task.status === 'planned' || task.status === 'rework') &&
          !dispatchedTaskIds.has(task.task_id)
      )
      .sort((left, right) => left.task_id.localeCompare(right.task_id));

    if (graphTasks.length === 0) break;
    followupIterations += 1;
    if (followupIterations > maxFollowupIterations) {
      const summary = `Mission follow-up iteration limit reached (${maxFollowupIterations}); remaining tasks were blocked.`;
      logger.warn(`[worker] ${summary}`);
      emitMissionOrchestrationObservation({
        event_type: 'mission_owner_notified',
        decision: 'mission_owner_notified',
        mission_id: missionId,
        reason: 'followup_iteration_limit',
        gate_rework_count: followupIterations,
        gate_reasons: [summary],
        payload: { max_followup_iterations: maxFollowupIterations },
      });
      try {
        const env = buildExecutionEnv(process.env, 'mission_controller');
        deps.runMissionController(env, [
          'pause',
          missionId,
          '--note',
          `${summary} Resume after reviewing the blocked task frontier.`,
        ]);
      } catch (err) {
        logger.warn(
          `[worker] failed to pause mission ${missionId} after iteration limit (non-fatal): ${err instanceof Error ? err.message : String(err)}`
        );
      }
      for (const task of graphTasks) {
        task.status = 'blocked';
        deps.recordMissionContextTask(missionId, `Blocked work item ${task.task_id}`, {
          summary,
          next_step:
            'raise the iteration limit through team governance after investigating the loop',
          work_item_id: task.task_id,
          reason: 'blocked(followup_iteration_limit)',
          max_followup_iterations: maxFollowupIterations,
        });
      }
      break;
    }

    const batchExecutors = new Map<
      string,
      (
        upstreamHandoffs?: Array<MissionGraphHandoff<DispatchMissionTaskOutcome, TaskResultBlock>>
      ) => Promise<DispatchMissionTaskOutcome | null>
    >();
    let waveMadeProgress = false;
    for (const task of graphTasks) {
      const teamRole = task.assigned_to?.role;
      if (!teamRole) {
        task.status = 'blocked';
        waveMadeProgress = true;
        const summary = deps.buildUnassignedRoleSummary(task);
        emitMissionTaskEvent({
          event_type: 'task_reviewed',
          mission_id: missionId,
          task_id: task.task_id,
          agent_id: task.assigned_to?.agent_id || 'mission-orchestration-worker',
          team_role: 'unassigned',
          decision: 'task_reviewed',
          why: summary,
          policy_used: 'mission_orchestration_control_plane_v1',
          evidence: task.deliverable ? [String(task.deliverable)] : [],
          payload: {
            description: task.description,
            deliverable: task.deliverable,
            reason: 'blocked(unassigned_role)',
            summary,
          },
        });
        deps.recordMissionContextTask(missionId, `Blocked work item ${task.task_id}`, {
          summary,
          next_step: 'assign a team role before retrying the work item',
          work_item_id: task.task_id,
          team_role: 'unassigned',
          assignee_peer_id: task.assigned_to?.agent_id,
          reason: 'blocked(unassigned_role)',
        });
        batchExecutors.set(task.task_id, async () => null);
        continue;
      }
      const reviewArtifact =
        teamRole === 'reviewer' || teamRole === 'qa'
          ? prepareArtifactReviewTask({ missionId, reviewTask: task, tasks: allTasks })
          : null;
      const assignment = resolveMissionTeamReceiver({
        missionId,
        teamRole,
        ...(reviewArtifact && task.artifact_review_profile
          ? {
              excludedAgentIds: task.artifact_review_profile.implementer_agent_ids,
              requiredCapabilities: task.artifact_review_profile.required_reviewer_capabilities,
            }
          : {}),
      });
      const reviewProfile = task.artifact_review_profile;
      const reviewerIndependenceFailure =
        assignment &&
        reviewProfile?.independence_required &&
        (reviewProfile.implementer_agent_ids.length === 0 ||
          reviewProfile.implementer_agent_ids.includes(assignment.agent_id || ''));
      if (reviewerIndependenceFailure) {
        task.status = 'blocked';
        waveMadeProgress = true;
        const summary =
          reviewProfile.implementer_agent_ids.length === 0
            ? 'Artifact review blocked because the implementation agent identity is unavailable.'
            : `Artifact review blocked because ${assignment.agent_id} also implemented the target artifact.`;
        emitMissionTaskEvent({
          event_type: 'task_reviewed',
          mission_id: missionId,
          task_id: task.task_id,
          agent_id: assignment.agent_id || 'mission-orchestration-worker',
          team_role: teamRole,
          decision: 'task_reviewed',
          why: summary,
          policy_used: 'artifact_review_independence_v1',
          evidence: reviewProfile.artifact_path ? [reviewProfile.artifact_path] : [],
          payload: {
            description: task.description,
            review_target: resolveReviewTargetForTask(task),
            implementer_agent_ids: reviewProfile.implementer_agent_ids,
            required_reviewer_roles: reviewProfile.required_reviewer_roles,
            reason: 'blocked(reviewer_independence)',
          },
        });
        deps.recordMissionContextTask(missionId, `Blocked artifact review ${task.task_id}`, {
          summary,
          next_step: 'assign an independent capable reviewer before retrying the review task',
          work_item_id: task.task_id,
          team_role: teamRole,
          assignee_peer_id: assignment.agent_id || undefined,
          reason: 'blocked(reviewer_independence)',
        });
        batchExecutors.set(task.task_id, async () => null);
        continue;
      }
      // Fill in a routed model hint only when the team plan did not already
      // pin one — plan-level hints stay authoritative (MO-05 shadow routing).
      if (assignment && !assignment.model_hint) {
        const phaseKind: TaskModelPhaseKind =
          teamRole === 'planner'
            ? 'plan'
            : teamRole === 'reviewer' || teamRole === 'qa'
              ? 'review'
              : teamRole === 'formatter' || teamRole === 'linter'
                ? 'mechanical'
                : 'implement';
        assignment.model_hint = resolveTaskModelHint({
          phase_kind: phaseKind,
          risk: task.risk,
          estimated_scope: task.estimated_scope,
        });
      }
      if (!assignment?.agent_id) {
        task.status = 'blocked';
        waveMadeProgress = true;
        const summary = deps.buildUnassignedRoleSummary(task, teamRole);
        emitMissionTaskEvent({
          event_type: 'task_reviewed',
          mission_id: missionId,
          task_id: task.task_id,
          agent_id: 'mission-orchestration-worker',
          team_role: teamRole,
          decision: 'task_reviewed',
          why: summary,
          policy_used: 'mission_orchestration_control_plane_v1',
          evidence: task.deliverable ? [String(task.deliverable)] : [],
          payload: {
            description: task.description,
            deliverable: task.deliverable,
            reason: 'blocked(unassigned_role)',
            team_role: teamRole,
            summary,
          },
        });
        deps.recordMissionContextTask(missionId, `Blocked work item ${task.task_id}`, {
          summary,
          next_step: `assign an agent for role ${teamRole} before retrying the work item`,
          work_item_id: task.task_id,
          team_role: teamRole,
          reason: 'blocked(unassigned_role)',
        });
        batchExecutors.set(task.task_id, async () => null);
        continue;
      }
      const preflight = validateDelegatedTaskPreflight({
        task: {
          task_id: task.task_id,
          team_role: teamRole,
          deliverable: task.deliverable,
          // Planner tasks use mission-relative targets ('evidence/…') while
          // allowed_write_scopes are repo-relative prefixes ('active/missions/…')
          // — anchor the effective target (explicit target_path, or the path
          // inferred from deliverable) to the mission directory beforehand.
          target_path: resolveMissionRelativeTargetPath(
            missionId,
            inferTaskTargetPath({ target_path: task.target_path, deliverable: task.deliverable })
          ),
        },
        assignment,
      });
      emitMissionOrchestrationObservation({
        decision: preflight.allowed
          ? 'delegation_preflight_passed'
          : 'delegation_preflight_blocked',
        event_type: 'delegation_preflight_checked',
        requested_by: 'mission_orchestration_worker',
        mission_id: missionId,
        resource_id: task.task_id,
        operation: preflight.allowed ? 'allow' : 'block',
        why: preflight.reason,
        evidence: preflight.target_path ? [preflight.target_path] : [],
        payload: {
          team_role: teamRole,
          target_path: preflight.target_path,
          target_scope_class: preflight.target_scope_class,
          warnings: preflight.warnings,
        },
      });
      if (!preflight.allowed) {
        task.status = 'blocked';
        waveMadeProgress = true;
        batchExecutors.set(task.task_id, async () => null);
        continue;
      }

      batchExecutors.set(task.task_id, async (upstreamHandoffs = []) => {
        missionRunTrace?.addEvent('mission_task_dispatch_started', {
          task_id: task.task_id,
          team_role: teamRole,
          agent_id: assignment.agent_id,
        });
        let outcome: DispatchMissionTaskOutcome | null | 'timeout' = null;
        let dispatchError: string | undefined;
        try {
          outcome = (await deps.withTaskDispatchTimeout(
            task,
            deps.dispatchPlannedMissionTask({
              missionId,
              task,
              ...(resumeGoalDriven ? { resumeGoalDriven: true } : {}),
              teamRole,
              assignment,
              allTasks,
              iterationPolicy,
              upstreamHandoffs,
            })
          )) as DispatchMissionTaskOutcome | null | 'timeout';
        } catch (error) {
          dispatchError = error instanceof Error ? error.message : String(error);
          task.status = 'blocked';
          const summary = `Task ${task.task_id} failed during graph dispatch: ${dispatchError}`;
          logger.error(`[worker] ${summary}`);
          deps.recordMissionContextTask(missionId, `Blocked work item ${task.task_id}`, {
            summary,
            next_step: 'inspect the graph node failure evidence before retrying the task',
            work_item_id: task.task_id,
            team_role: teamRole,
            reason: 'blocked(dispatch_error)',
            error: dispatchError,
          });
          missionRunTrace?.addEvent('mission_task_dispatch_finished', {
            task_id: task.task_id,
            status: 'error',
            error: dispatchError,
          });
          return {
            task_id: task.task_id,
            team_role: teamRole,
            agent_id: assignment.agent_id,
            dispatched: false,
            dispatch_error: dispatchError,
            rollup_used: false,
            result_schema_ok: false,
            needs_count: 0,
          };
        }
        if (outcome === 'timeout') {
          task.status = 'blocked';
          const summary = `Task ${task.task_id} exceeded its dispatch budget (${deps.resolveTaskDispatchTimeoutMs(task)}ms) — blocked(timeout).`;
          logger.warn(`[worker] ${summary}`);
          deps.recordMissionContextTask(missionId, `Blocked work item ${task.task_id}`, {
            summary,
            next_step: 'investigate the hung worker, then set the task back to rework',
            work_item_id: task.task_id,
            team_role: teamRole,
            reason: 'blocked(timeout)',
          });
          missionRunTrace?.addEvent('mission_task_dispatch_finished', {
            task_id: task.task_id,
            status: 'timeout',
          });
          return null;
        }
        missionRunTrace?.addEvent('mission_task_dispatch_finished', {
          task_id: task.task_id,
          status: outcome?.dispatched ? 'completed' : 'not_dispatched',
        });
        return outcome;
      });
    }

    if (batchExecutors.size === 0) continue;

    // GE-05: schedule the prepared frontier through the shared completion-
    // driven graph scheduler. The governance cap remains the global upper
    // bound for this mission invocation; same-agent serialization is not
    // inferred because the existing team contract permits it.
    // Keep the frontier deterministic across planner JSON ordering. The
    // scheduler still honors dependency edges, while independent nodes are
    // started in the same task_id order as the legacy worker contract.
    const graphTaskOrder = [...allTasks].sort((left, right) =>
      left.task_id.localeCompare(right.task_id)
    );
    const graphInputs = buildMissionGraphInputs(graphTaskOrder);
    const derivedFrontier = deriveExecutionGraph(graphInputs);
    if (derivedFrontier.errors.length > 0) {
      throw new Error(
        `[MISSION_GRAPH_PREFLIGHT] ${derivedFrontier.errors.map((error) => error.message).join('; ')}`
      );
    }
    const taskById = new Map(graphTaskOrder.map((task) => [task.task_id, task]));
    const frontierGraph = {
      nodes: derivedFrontier.graph.nodes.map((node) => ({
        ...node,
        value: taskById.get(node.id)!,
      })),
      edges: derivedFrontier.graph.edges,
    };
    const terminalSuccessIds = allTasks
      .filter((task) => ['completed', 'accepted', 'reviewed'].includes(String(task.status || '')))
      .map((task) => task.task_id)
      .concat([...dispatchedTaskIds]);
    const terminalBlockedIds = allTasks
      .filter((task) => ['blocked', 'requested'].includes(String(task.status || '')))
      .map((task) => task.task_id);
    const frontierResult = await executeGraph<PlannedNextTask, Record<string, unknown>>(
      frontierGraph,
      async (node: GraphNode<PlannedNextTask>, graphContext) => {
        const executor = batchExecutors.get(node.id);
        if (!executor) return { status: 'skipped' as const, error: 'task is not dispatchable' };
        const upstreamHandoffs = collectMissionGraphHandoffs<
          DispatchMissionTaskOutcome,
          TaskResultBlock
        >(graphContext, node.dependencies);
        const outcome = await executor(upstreamHandoffs);
        const dispatchError = outcome?.dispatch_error;
        const task = taskById.get(node.id);
        const handoff = task
          ? {
              from_task_id: node.id,
              status: String(task.status || 'planned'),
              ...(outcome ? { outcome } : {}),
              ...(task.last_result ? { task_result: task.last_result } : {}),
            }
          : undefined;
        const nodeState =
          task?.status === 'blocked' || task?.status === 'requested'
            ? 'blocked'
            : outcome?.dispatched
              ? 'completed'
              : 'rework';
        graphRunJournal.append('node_state', {
          task_id: node.id,
          state: nodeState,
          ...(outcome ? { outcome: outcome as unknown as Record<string, unknown> } : {}),
          ...(task ? { task_snapshot: task as unknown as Record<string, unknown> } : {}),
        });
        if (dispatchError) {
          return { status: 'failed' as const, error: dispatchError };
        }
        return outcome
          ? {
              status: outcome.dispatched ? ('success' as const) : ('failed' as const),
              context: handoff ? { handoff } : undefined,
              ...(outcome.dispatched ? {} : { error: 'task handoff requires re-dispatch' }),
            }
          : { status: 'failed' as const, error: 'task was blocked before dispatch' };
      },
      {
        initialContext: {},
        maxConcurrency: maxParallelMembers,
        precompletedNodeIds: terminalSuccessIds,
        preskippedNodeIds: terminalBlockedIds,
        precompletedNodeContext: (node) => {
          const task = node.value as PlannedNextTask;
          const persisted = graphRunJournal.state().node_states.get(task.task_id);
          const persistedOutcome = persisted?.outcome;
          const persistedTaskResult = persisted?.task_snapshot?.last_result;
          return task.last_result || persistedOutcome || persistedTaskResult
            ? {
                handoff: {
                  from_task_id: task.task_id,
                  status: String(task.status || 'completed'),
                  ...(persistedOutcome ? { outcome: persistedOutcome } : {}),
                  ...(task.last_result || persistedTaskResult
                    ? { task_result: task.last_result || persistedTaskResult }
                    : {}),
                },
              }
            : undefined;
        },
        resourceClaims: (node) => {
          const task = node.value as PlannedNextTask;
          return task.resource_claims || [];
        },
      }
    );
    const results = graphTasks
      .map(
        (task) =>
          (
            frontierResult.outcomes[task.task_id]?.context as
              { handoff?: { outcome?: DispatchMissionTaskOutcome } } | undefined
          )?.handoff?.outcome as DispatchMissionTaskOutcome | undefined
      )
      .filter((outcome): outcome is DispatchMissionTaskOutcome => Boolean(outcome));
    const cascadedIds = deps.cascadeBlockedDependents(plannedTasks);
    if (cascadedIds.length > 0) {
      logger.warn(
        `[worker] blocked dependency cascade for ${missionId}: ${cascadedIds.join(', ')}`
      );
    }
    for (const result of results) {
      if (result) {
        if (!result.allowSameInvocationRedispatch) {
          dispatchedTaskIds.add(result.task_id);
        }
        if (Array.isArray(result.redispatchTaskIds)) {
          for (const redispatchTaskId of result.redispatchTaskIds) {
            dispatchedTaskIds.delete(redispatchTaskId);
          }
        }
        waveMadeProgress = true;
        dispatchObservability.push(result);
        if (result.dispatched || result.result_schema_ok) {
          dispatched.push({
            task_id: result.task_id,
            team_role: result.team_role,
            agent_id: result.agent_id,
          });
        }
      }
    }

    if (!waveMadeProgress) break;
  }

  deps.writeNextTasks(missionId, allTasks);
  deps.markTaskBoardInProgress(missionId);
  deps.reconcileMissionProgress(missionId);
  graphRunJournal.append('graph_finished', {
    status: 'completed',
    remaining_planned_count: deps.loadPlannedNextTasks(missionId).length,
  });
  const contextChars = dispatchObservability
    .map((entry) => entry.context_chars)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const prunedChars = dispatchObservability
    .map((entry) => entry.pruned_chars)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const needsCountTotal = dispatchObservability.reduce(
    (count, entry) => count + entry.needs_count,
    0
  );
  const resultSchemaOkCount = dispatchObservability.filter(
    (entry) => entry.result_schema_ok
  ).length;
  const rollupCount = dispatchObservability.filter((entry) => entry.rollup_used).length;
  ledger.record('MISSION_FOLLOWUP_DISPATCHED', {
    mission_id: missionId,
    dispatched_task_count: dispatched.length,
    task_ids: dispatched.map((task) => task.task_id),
    average_context_chars:
      contextChars.length > 0
        ? Math.round(contextChars.reduce((sum, value) => sum + value, 0) / contextChars.length)
        : undefined,
    average_pruned_chars:
      prunedChars.length > 0
        ? Math.round(prunedChars.reduce((sum, value) => sum + value, 0) / prunedChars.length)
        : undefined,
    needs_rate:
      dispatchObservability.length > 0 ? needsCountTotal / dispatchObservability.length : 0,
    result_schema_ok_rate:
      dispatchObservability.length > 0 ? resultSchemaOkCount / dispatchObservability.length : 0,
    rollup_used_count: rollupCount,
  });
  return dispatched;
}

/**
 * GE-08: one durable trace root per mission-worker invocation. Task dispatch
 * traces remain independently queryable for the existing operator surfaces;
 * this run-level trace adds the missing invocation boundary and a compact
 * event stream linking every task attempt to the same trace id.
 */
