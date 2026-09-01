import { AgentBusyError } from './a2a-bridge.js';
import * as path from 'node:path';
import { notifyOperator } from './operator-notifications.js';
import { type DelegationChain } from './delegation-chain.js';
import { missionCoordinationBus } from './mission-coordination-bus.js';
import {
  claimWorkItem,
  importExternalWorkItem,
  releaseWorkItem,
  updateWorkItem,
} from './work-coordination.js';
import { logger } from './core.js';
import { canonicalizeTeamRole } from './working-principles.js';
import { TraceContext } from './src/trace.js';
import { type GapRecorder } from './gap-phase.js';
import { emitMissionTaskEvent } from './mission-task-events.js';
import { emitMissionOrchestrationObservation } from './mission-orchestration-events.js';
import { provisionMissionEntry, writeProvisionedJson } from './mission-orchestration-journal.js';
import {
  normalizeReviewFindings,
  persistArtifactReviewReceipt,
  prepareArtifactReviewTask,
  resolveReviewTargetForTask,
} from './mission-orchestration-artifact-review.js';
export { resolveMissionPlanningPacket } from './mission-orchestration-planning.js';

export {
  evaluateMissionPhaseExitGates,
  loadMissionPhaseGateDefinitions,
  resolvePhaseGateMode,
} from './mission-orchestration-phase-gates.js';
import { isPromptTooLongError } from './worker-context-compaction.js';

import {
  recordMissionContextTask,
  taskClarificationFilePath,
  summarizeTaskResultObservability,
  buildTaskClarificationPacket,
  evaluateTaskAcceptanceGate,
  requestIndependentAcceptanceReview,
} from './mission-orchestration-worker-part-context.js';
import type {
  DispatchMissionTaskOutcome,
  IndependentAcceptanceReview,
} from './mission-orchestration-worker-part-context.js';
import {
  buildTaskDispatchContext,
  attachDeliveredKnowledgeRefs,
} from './mission-orchestration-worker-part-dispatch-context.js';
import type { DispatchPlannedMissionTaskInput } from './mission-orchestration-worker-part-dispatch-context.js';
import {
  obtainTaskResultResponse,
  isDraftRefineCandidate,
  applyDraftRefineToDeliverable,
  isBestOfNCandidate,
  obtainBestOfTaskResultResponse,
  publishTaskPrArtifacts,
  loadAllNextTasks,
} from './mission-orchestration-worker-part-results.js';
import { registerMissionWorkerCoreDispatcher } from './mission-orchestration-worker-dispatch-port.js';

export async function dispatchPlannedMissionTaskCore(
  input: DispatchPlannedMissionTaskInput,
  traceCtx: TraceContext,
  delegationChain?: DelegationChain,
  gapRecorder?: GapRecorder
): Promise<DispatchMissionTaskOutcome | null> {
  const workItemSourceRef = `mission:${input.missionId}:${input.task.task_id}`;
  const workItem = importExternalWorkItem({
    source: 'local',
    sourceRef: workItemSourceRef,
    title: input.task.description || input.task.task_id,
    description: input.task.description || input.task.task_id,
    status: 'ready',
    priority: 'normal',
    projectId: input.missionId,
    assigneePeerId: input.assignment.agent_id,
    labels: [`mission:${input.missionId}`, `team_role:${input.teamRole}`],
    dependencies: Array.isArray(input.task.dependencies) ? input.task.dependencies : [],
    metadata: {
      deliverable: input.task.deliverable,
      target_path: input.task.target_path,
      acceptance_criteria: input.task.acceptance_criteria,
      risk: input.task.risk,
      estimated_scope: input.task.estimated_scope,
      task_id: input.task.task_id,
      mission_id: input.missionId,
    },
  });
  const claimed = claimWorkItem({
    itemId: workItem.item_id,
    actorPeerId: 'mission-orchestration-worker',
    purpose: `dispatch mission task ${input.missionId}/${input.task.task_id}`,
    expectedVersion: workItem.version,
    idempotencyKey: workItemSourceRef,
    metadata: {
      mission_id: input.missionId,
      task_id: input.task.task_id,
      team_role: input.teamRole,
      deliverable: input.task.deliverable,
      target_path: input.task.target_path,
      acceptance_criteria: input.task.acceptance_criteria,
      risk: input.task.risk,
      estimated_scope: input.task.estimated_scope,
    },
  });
  let dispatchContext;
  let response;
  const buildContext = (forceContextCompaction?: boolean) =>
    buildTaskDispatchContext({
      missionId: input.missionId,
      task: input.task,
      teamRole: input.teamRole,
      agentId: input.assignment.agent_id,
      authorityRole: input.assignment.authority_role,
      taskModelHint: input.assignment.model_hint,
      allTasks: input.allTasks,
      ...(input.upstreamHandoffs ? { upstreamHandoffs: input.upstreamHandoffs } : {}),
      ...(forceContextCompaction ? { forceContextCompaction: true } : {}),
    });
  const dispatchOnce = (context: Awaited<ReturnType<typeof buildTaskDispatchContext>>) => {
    const dispatchArgs = {
      missionId: input.missionId,
      task: input.task,
      teamRole: input.teamRole,
      agentId: input.assignment.agent_id,
      taskModelHint: input.assignment.model_hint,
      provider: input.assignment.provider || undefined,
      providerModelId: input.assignment.modelId || undefined,
      prompt: [context.prompt, input.queuedInputPrompt].filter(Boolean).join('\n\n'),
      contextPackId: context.missionContextPackId,
      securityScope: context.securityScope,
      // KP-04: lets a needs-driven retry's second-round retrieval exclude
      // what the first-round context pack already delivered.
      deliveredKnowledgeRefs: context.deliveredKnowledgeRefs,
      // NI-03: the originated delegation chain rides into the task contract
      // payload and the A2A envelope header.
      delegationChain,
    };
    return isBestOfNCandidate({ teamRole: input.teamRole, task: input.task })
      ? obtainBestOfTaskResultResponse(dispatchArgs)
      : obtainTaskResultResponse(dispatchArgs);
  };
  try {
    dispatchContext = await (gapRecorder
      ? gapRecorder.measure('context_pack', () => buildContext())
      : buildContext());
    try {
      response = await (gapRecorder
        ? gapRecorder.measure('backend_dispatch', () => dispatchOnce(dispatchContext))
        : dispatchOnce(dispatchContext));
    } catch (dispatchError: any) {
      // OH-01 reactive compaction: a provider-side "prompt too long" gets one
      // forced-compaction rebuild + retry before the failure propagates.
      if (!isPromptTooLongError(dispatchError)) throw dispatchError;
      logger.warn(
        `[MISSION_WORKER] Dispatch prompt too long for ${input.task.task_id}; forcing context compaction and retrying once.`
      );
      dispatchContext = await (gapRecorder
        ? gapRecorder.measure('context_pack', () => buildContext(true))
        : buildContext(true));
      response = await (gapRecorder
        ? gapRecorder.measure('backend_dispatch', () => dispatchOnce(dispatchContext))
        : dispatchOnce(dispatchContext));
    }
  } catch (err: any) {
    if (err instanceof AgentBusyError || err?.name === 'AgentBusyError') {
      logger.warn(
        `[MISSION_WORKER] Agent ${input.assignment.agent_id} is busy. Resetting task ${input.task.task_id} to planned for retry.`
      );
      input.task.status = 'planned';
      try {
        releaseWorkItem({
          itemId: workItem.item_id,
          actorPeerId: 'mission-orchestration-worker',
          expectedVersion: claimed.item.version,
          leaseId: claimed.lease.lease_id,
        });
      } catch (releaseErr: any) {
        logger.error(`[MISSION_WORKER] Failed to release work item claim: ${releaseErr.message}`);
      }
      return null;
    }
    throw err;
  }
  // KP-05: report what buildTaskDispatchContext's context pack actually
  // delivered onto this dispatch's trace span.
  attachDeliveredKnowledgeRefs(traceCtx, dispatchContext.deliveredKnowledgeRefs);
  emitMissionTaskEvent({
    event_type: 'participant_context_resolved',
    mission_id: input.missionId,
    task_id: input.task.task_id,
    agent_id: input.assignment.agent_id,
    team_role: input.teamRole,
    decision: 'dispatch_context_compiled',
    why: 'Record the resolved execution actor, perspective, model route, and security scope.',
    policy_used: 'participant_context_v1',
    evidence: dispatchContext.missionContextPackPath
      ? [dispatchContext.missionContextPackPath]
      : [],
    payload: {
      organization_role_id: input.assignment.organization_role_id,
      perspective_ids: input.assignment.perspective_ids,
      reasoning_route_id: input.assignment.reasoning_route_id,
      selection_reason_codes: input.assignment.selection_reason_codes,
      provider: input.assignment.provider,
      model_id: input.assignment.modelId,
      security_scope: dispatchContext.securityScope,
      context_pack_id: dispatchContext.missionContextPackId,
      // NI-03: mission-task-events forwards this payload to the execution
      // ledger, where appendMissionExecutionLedgerEntry promotes it to the
      // first-class `delegation_chain` column for audit reconstruction.
      ...(delegationChain ? { delegation_chain: delegationChain } : {}),
    },
  });
  const taskResultNeeds = response.taskResult?.needs || [];
  const dispatchCanonicalTeamRole = canonicalizeTeamRole(input.teamRole);
  const reviewFindings = normalizeReviewFindings(
    response.taskResult?.review_findings ||
      (dispatchCanonicalTeamRole === 'reviewer' || dispatchCanonicalTeamRole === 'qa'
        ? (response.taskResult?.gaps || []).map((gap) => ({
            severity: 'must_fix' as const,
            location: reviewTarget || input.task.deliverable || input.task.task_id,
            instruction: String(gap || '').trim(),
          }))
        : [])
  );
  if (response.taskResult) {
    input.task.last_result = {
      ...response.taskResult,
      review_findings:
        reviewFindings.length > 0 ? reviewFindings : response.taskResult.review_findings,
    };
  }
  const taskResultObservability = summarizeTaskResultObservability({
    pruning: dispatchContext.missionContextPackPruningSummary,
    taskResult: response.taskResult,
    parseErrors: response.parseErrors,
  });
  const taskResultBlocked =
    !response.taskResult || response.parseErrors.length > 0 || taskResultNeeds.length > 0;
  const clarificationPacket =
    taskResultNeeds.length > 0 && response.taskResult
      ? buildTaskClarificationPacket({
          missionId: input.missionId,
          task: input.task,
          taskResult: response.taskResult,
        })
      : undefined;
  const clarificationPacketPath = clarificationPacket
    ? taskClarificationFilePath(input.missionId, input.task.task_id)
    : undefined;

  if (taskResultBlocked && clarificationPacket && clarificationPacketPath) {
    updateWorkItem({
      itemId: claimed.item.item_id,
      expectedVersion: claimed.item.version,
      status: 'blocked',
      metadata: {
        summary: 'Task result needs clarification before completion',
        blocked_reason: 'task_result_needs_input',
        mission_id: input.missionId,
        task_id: input.task.task_id,
        team_role: input.teamRole,
      },
    });
    writeProvisionedJson({
      missionId: input.missionId,
      filePath: clarificationPacketPath,
      targetPath: `evidence/task-clarification-${input.task.task_id}.json`,
      missionPathHint: path.dirname(path.dirname(clarificationPacketPath)),
      provisioned: provisionMissionEntry({
        mission_id: input.missionId,
        task_id: input.task.task_id,
        task_result: response.taskResult,
        clarification_packet: clarificationPacket,
        clarification_packet_path: clarificationPacketPath,
        needs: taskResultNeeds,
        status: 'needs_input',
        written_at: new Date().toISOString(),
      }),
    });
    input.task.status = 'blocked';
    emitMissionTaskEvent({
      event_type: 'task_reviewed',
      mission_id: input.missionId,
      task_id: input.task.task_id,
      agent_id: input.assignment.agent_id,
      team_role: input.teamRole,
      decision: 'task_reviewed',
      why: 'Task result still needs clarification before the work can continue.',
      policy_used: 'mission_orchestration_control_plane_v1',
      evidence: input.task.deliverable ? [String(input.task.deliverable)] : [],
      payload: {
        description: input.task.description,
        deliverable: input.task.deliverable,
        clarification_packet_path: clarificationPacketPath,
        needs: taskResultNeeds,
        task_result: response.taskResult,
        task_result_errors: response.parseErrors,
        ...taskResultObservability,
      },
    });
    recordMissionContextTask(input.missionId, `Blocked work item ${input.task.task_id}`, {
      next_step: 'resolve the missing inputs before retrying the work item',
      work_item_id: input.task.task_id,
      team_role: input.teamRole,
      assignee_peer_id: input.assignment.agent_id,
      execution_mode: response.executionMode,
      context_pack_id: dispatchContext.missionContextPackId,
      context_pack_path: dispatchContext.missionContextPackPath,
      context_pack_summary: dispatchContext.missionContextPackSummary,
      context_pack_pruning_summary: dispatchContext.missionContextPackPruningSummary,
      ...taskResultObservability,
    });
    return {
      task_id: input.task.task_id,
      team_role: input.teamRole,
      agent_id: input.assignment.agent_id,
      dispatched: false,
      ...taskResultObservability,
    };
  }

  if (taskResultBlocked) {
    updateWorkItem({
      itemId: claimed.item.item_id,
      expectedVersion: claimed.item.version,
      status: 'blocked',
      metadata: {
        summary: 'Task result did not satisfy the structured response contract',
        blocked_reason: 'task_result_unstructured',
        mission_id: input.missionId,
        task_id: input.task.task_id,
        team_role: input.teamRole,
      },
    });
    input.task.status = 'blocked';
    emitMissionTaskEvent({
      event_type: 'task_reviewed',
      mission_id: input.missionId,
      task_id: input.task.task_id,
      agent_id: input.assignment.agent_id,
      team_role: input.teamRole,
      decision: 'task_reviewed',
      why: 'Task result did not satisfy the structured response contract.',
      policy_used: 'mission_orchestration_control_plane_v1',
      evidence: input.task.deliverable ? [String(input.task.deliverable)] : [],
      payload: {
        description: input.task.description,
        deliverable: input.task.deliverable,
        task_result: response.taskResult,
        task_result_errors: response.parseErrors,
        notes: response.notes,
        ...taskResultObservability,
      },
    });
    recordMissionContextTask(input.missionId, `Blocked work item ${input.task.task_id}`, {
      next_step: 'repair the structured task result response before retrying',
      work_item_id: input.task.task_id,
      team_role: input.teamRole,
      assignee_peer_id: input.assignment.agent_id,
      execution_mode: response.executionMode,
      context_pack_id: dispatchContext.missionContextPackId,
      context_pack_path: dispatchContext.missionContextPackPath,
      context_pack_summary: dispatchContext.missionContextPackSummary,
      context_pack_pruning_summary: dispatchContext.missionContextPackPruningSummary,
      ...taskResultObservability,
    });
    return {
      task_id: input.task.task_id,
      team_role: input.teamRole,
      agent_id: input.assignment.agent_id,
      dispatched: false,
      ...taskResultObservability,
    };
  }

  const reviewTarget = resolveReviewTargetForTask(input.task);
  const isArtifactReview =
    dispatchCanonicalTeamRole === 'reviewer' || dispatchCanonicalTeamRole === 'qa';
  const targetTask =
    isArtifactReview && reviewTarget
      ? input.allTasks.find((task) => task.task_id === reviewTarget)
      : undefined;
  const reviewArtifact = isArtifactReview
    ? prepareArtifactReviewTask({
        missionId: input.missionId,
        reviewTask: input.task,
        tasks: input.allTasks,
      })
    : null;
  if (isArtifactReview && targetTask && !reviewArtifact?.absolutePath) {
    reviewFindings.push({
      severity: 'must_fix',
      location: reviewTarget || input.task.task_id,
      instruction: 'Review target artifact is unavailable for hash-bound quality review.',
    });
  }
  const hasMustFixFindings = reviewFindings.some((finding) => finding.severity === 'must_fix');
  if (isArtifactReview && reviewTarget) {
    input.task.review_findings = reviewFindings;
    const currentReviewRound = Math.max(
      Number(input.task.review_round || 0),
      Number(input.task.rework_count || 0)
    );
    const nextReviewRound = currentReviewRound + 1;
    if (reviewArtifact?.absolutePath) {
      persistArtifactReviewReceipt({
        missionId: input.missionId,
        reviewTask: input.task,
        teamRole: dispatchCanonicalTeamRole as 'reviewer' | 'qa',
        reviewerAgentId: input.assignment.agent_id,
        artifact: reviewArtifact,
        findings: reviewFindings,
        reviewRound: nextReviewRound,
      });
    }
    if (!targetTask) {
      updateWorkItem({
        itemId: claimed.item.item_id,
        expectedVersion: claimed.item.version,
        status: 'blocked',
        metadata: {
          summary: response.taskResult?.summary || input.task.description || input.task.task_id,
          blocked_reason: `missing review target ${reviewTarget}`,
          mission_id: input.missionId,
          task_id: input.task.task_id,
          team_role: input.teamRole,
        },
      });
      input.task.status = 'blocked';
      emitMissionTaskEvent({
        event_type: 'task_reviewed',
        mission_id: input.missionId,
        task_id: input.task.task_id,
        agent_id: input.assignment.agent_id,
        team_role: input.teamRole,
        decision: 'task_reviewed',
        why: `Reviewer task references missing review target ${reviewTarget}.`,
        policy_used: 'mission_orchestration_control_plane_v1',
        evidence: input.task.deliverable ? [String(input.task.deliverable)] : [],
        payload: {
          description: input.task.description,
          deliverable: input.task.deliverable,
          review_target: reviewTarget,
          task_result: response.taskResult,
          review_findings: reviewFindings,
          ...taskResultObservability,
        },
      });
      return {
        task_id: input.task.task_id,
        team_role: input.teamRole,
        agent_id: input.assignment.agent_id,
        dispatched: false,
        allowSameInvocationRedispatch: false,
        redispatchTaskIds: [],
        ...taskResultObservability,
      };
    }

    if (hasMustFixFindings && currentReviewRound >= input.iterationPolicy.max_review_rounds) {
      updateWorkItem({
        itemId: claimed.item.item_id,
        expectedVersion: claimed.item.version,
        status: 'blocked',
        metadata: {
          summary: response.taskResult?.summary || input.task.description || input.task.task_id,
          blocked_reason: 'review_rework_round_limit',
          mission_id: input.missionId,
          task_id: input.task.task_id,
          team_role: input.teamRole,
        },
      });
      input.task.status = 'blocked';
      input.task.review_round = nextReviewRound;
      input.task.rework_count = nextReviewRound;
      targetTask.status = 'blocked';
      targetTask.rework_count = Math.max(Number(targetTask.rework_count || 0), nextReviewRound);
      targetTask.rework_packet = {
        from_task: input.task.task_id,
        findings: reviewFindings,
        round: nextReviewRound,
      };
      emitMissionTaskEvent({
        event_type: 'task_reviewed',
        mission_id: input.missionId,
        task_id: input.task.task_id,
        agent_id: input.assignment.agent_id,
        team_role: input.teamRole,
        decision: 'task_reviewed',
        why: 'Review findings exceeded the re-review limit.',
        policy_used: 'mission_orchestration_control_plane_v1',
        evidence: input.task.deliverable ? [String(input.task.deliverable)] : [],
        payload: {
          description: input.task.description,
          deliverable: input.task.deliverable,
          review_target: reviewTarget,
          task_result: response.taskResult,
          review_findings: reviewFindings,
          review_round: nextReviewRound,
          ...taskResultObservability,
        },
      });
      emitMissionOrchestrationObservation({
        event_type: 'mission_owner_notified',
        decision: 'mission_owner_notified',
        mission_id: input.missionId,
        task_id: input.task.task_id,
        team_role: input.teamRole,
        reason: 'Review findings exceeded the re-review limit.',
        gate_rework_count: nextReviewRound,
        gate_reasons: reviewFindings.map(
          (finding) => `${finding.location}: ${finding.instruction}`
        ),
      });
      return {
        task_id: input.task.task_id,
        team_role: input.teamRole,
        agent_id: input.assignment.agent_id,
        dispatched: false,
        allowSameInvocationRedispatch: false,
        redispatchTaskIds: [],
        ...taskResultObservability,
      };
    }

    if (hasMustFixFindings) {
      targetTask.status = 'rework';
      targetTask.rework_count = Math.max(Number(targetTask.rework_count || 0), nextReviewRound);
      targetTask.rework_packet = {
        from_task: input.task.task_id,
        findings: reviewFindings,
        round: nextReviewRound,
      };
      targetTask.review_findings = reviewFindings;
      input.task.status = 'planned';
      input.task.review_round = nextReviewRound;
      input.task.rework_count = nextReviewRound;
      releaseWorkItem({
        itemId: claimed.item.item_id,
        expectedVersion: claimed.item.version,
        leaseId: claimed.lease.lease_id,
        actorPeerId: 'mission-orchestration-worker',
        summary: response.taskResult?.summary || input.task.description || input.task.task_id,
        metadata: {
          summary: response.taskResult?.summary || input.task.description || input.task.task_id,
          blocked_reason: 'review_rework_requested',
          mission_id: input.missionId,
          task_id: input.task.task_id,
          team_role: input.teamRole,
          review_target: reviewTarget,
          review_round: nextReviewRound,
        },
      });
      try {
        missionCoordinationBus.send({
          mission_id: input.missionId,
          channel: 'handoff',
          from_agent: input.assignment.agent_id,
          from_role: input.teamRole,
          to_agent: targetTask.assigned_to?.agent_id,
          to_role: targetTask.assigned_to?.role,
          task_id: targetTask.task_id,
          content: `Review round ${nextReviewRound} sent ${reviewFindings.length} finding(s) back to ${targetTask.task_id} for rework.`,
        });
      } catch {
        // Coordination-bus visibility is best-effort; never block the rework handoff on it.
      }
      emitMissionTaskEvent({
        event_type: 'task_reviewed',
        mission_id: input.missionId,
        task_id: input.task.task_id,
        agent_id: input.assignment.agent_id,
        team_role: input.teamRole,
        decision: 'task_reviewed',
        why: 'Review requested rework on the target task.',
        policy_used: 'mission_orchestration_control_plane_v1',
        evidence: input.task.deliverable ? [String(input.task.deliverable)] : [],
        payload: {
          description: input.task.description,
          deliverable: input.task.deliverable,
          review_target: reviewTarget,
          task_result: response.taskResult,
          review_findings: reviewFindings,
          review_round: nextReviewRound,
          rework_requested: true,
          ...taskResultObservability,
        },
      });
      recordMissionContextTask(
        input.missionId,
        `Review rework requested for ${input.task.task_id}`,
        {
          next_step: 're-dispatch the target task with review findings to address',
          work_item_id: input.task.task_id,
          team_role: input.teamRole,
          assignee_peer_id: input.assignment.agent_id,
          review_target: reviewTarget,
          review_round: nextReviewRound,
          review_findings: reviewFindings,
          ...taskResultObservability,
        }
      );
      return {
        task_id: input.task.task_id,
        team_role: input.teamRole,
        agent_id: input.assignment.agent_id,
        dispatched: false,
        allowSameInvocationRedispatch: true,
        redispatchTaskIds: [targetTask.task_id],
        ...taskResultObservability,
      };
    }
  }

  if (isDraftRefineCandidate({ teamRole: input.teamRole, task: input.task })) {
    await applyDraftRefineToDeliverable({
      missionId: input.missionId,
      task: input.task,
      teamRole: input.teamRole,
    });
  }

  const acceptance = await evaluateTaskAcceptanceGate({
    missionId: input.missionId,
    task: input.task,
    taskResult: response.taskResult,
  });

  // Separation of duties: the deterministic gate only checks structure and
  // evidence presence, so a passing result additionally needs a semantic
  // verdict from an independent reviewer runtime (different actor than the
  // worker). Tasks that already have a dedicated reviewer task in the plan
  // (a task whose review_target points at them) are skipped — their review
  // happens through that task. Reviewer outage degrades to the deterministic
  // verdict rather than blocking the loop.
  let independentReview: IndependentAcceptanceReview | null = null;
  const hasDedicatedReviewTask = loadAllNextTasks(input.missionId).some(
    (task) => String(task.review_target || '') === input.task.task_id
  );
  if (acceptance.passed && !hasDedicatedReviewTask) {
    independentReview = await requestIndependentAcceptanceReview({
      missionId: input.missionId,
      task: input.task,
      taskResult: response.taskResult,
      workerAgentId: input.assignment.agent_id,
      workerTeamRole: input.teamRole,
      securityScope: dispatchContext.securityScope,
    });
    if (independentReview && !independentReview.approve) {
      acceptance.passed = false;
      acceptance.reasons = [
        ...acceptance.reasons,
        `Independent reviewer ${independentReview.reviewerAgentId} rejected: ${
          independentReview.gaps.join('; ') || independentReview.rationale || 'no gaps returned'
        }`,
      ];
    }
  }

  if (!acceptance.passed) {
    const currentReworkCount = Number(input.task.rework_count || 0);
    const nextReworkCount = currentReworkCount + 1;
    const gateReason = acceptance.reasons.join('; ') || 'task acceptance gate failed';

    if (currentReworkCount < input.iterationPolicy.max_rework_attempts) {
      input.task.rework_count = nextReworkCount;
      input.task.status = 'planned';
      releaseWorkItem({
        itemId: claimed.item.item_id,
        expectedVersion: claimed.item.version,
        leaseId: claimed.lease.lease_id,
        actorPeerId: 'mission-orchestration-worker',
        summary: response.taskResult?.summary || input.task.description || input.task.task_id,
        metadata: {
          summary: response.taskResult?.summary || input.task.description || input.task.task_id,
          blocked_reason: gateReason,
          mission_id: input.missionId,
          task_id: input.task.task_id,
          team_role: input.teamRole,
          task_result_retried: response.retried,
          rework_count: nextReworkCount,
          rework_requested: true,
        },
      });
      emitMissionTaskEvent({
        event_type: 'task_reviewed',
        mission_id: input.missionId,
        task_id: input.task.task_id,
        agent_id: input.assignment.agent_id,
        team_role: input.teamRole,
        decision: 'task_reviewed',
        why: 'Task acceptance gate failed; rework requested once.',
        policy_used: 'mission_orchestration_control_plane_v1',
        evidence: input.task.deliverable ? [String(input.task.deliverable)] : [],
        payload: {
          description: input.task.description,
          deliverable: input.task.deliverable,
          task_model_hint: input.assignment.model_hint,
          task_result: response.taskResult,
          task_result_retried: response.retried,
          gate_reasons: acceptance.reasons,
          gate_record_path: acceptance.recordPath,
          rework_count: nextReworkCount,
          rework_requested: true,
          ...taskResultObservability,
        },
      });
      recordMissionContextTask(input.missionId, `Rework requested for ${input.task.task_id}`, {
        next_step: 'retry the work item once after repairing the acceptance gaps',
        work_item_id: input.task.task_id,
        team_role: input.teamRole,
        assignee_peer_id: input.assignment.agent_id,
        execution_mode: response.executionMode,
        context_pack_id: dispatchContext.missionContextPackId,
        context_pack_path: dispatchContext.missionContextPackPath,
        context_pack_summary: dispatchContext.missionContextPackSummary,
        context_pack_pruning_summary: dispatchContext.missionContextPackPruningSummary,
        gate_reasons: acceptance.reasons,
        gate_record_path: acceptance.recordPath,
        rework_count: nextReworkCount,
        rework_requested: true,
        ...taskResultObservability,
      });
      return {
        task_id: input.task.task_id,
        team_role: input.teamRole,
        agent_id: input.assignment.agent_id,
        dispatched: false,
        allowSameInvocationRedispatch: false,
        redispatchTaskIds: [],
        ...taskResultObservability,
      };
    }

    updateWorkItem({
      itemId: claimed.item.item_id,
      expectedVersion: claimed.item.version,
      status: 'blocked',
      metadata: {
        summary: response.taskResult?.summary || input.task.description || input.task.task_id,
        blocked_reason: gateReason,
        mission_id: input.missionId,
        task_id: input.task.task_id,
        team_role: input.teamRole,
        task_result_retried: response.retried,
        rework_count: nextReworkCount,
      },
    });
    input.task.status = 'blocked';
    input.task.rework_count = nextReworkCount;
    emitMissionTaskEvent({
      event_type: 'task_reviewed',
      mission_id: input.missionId,
      task_id: input.task.task_id,
      agent_id: input.assignment.agent_id,
      team_role: input.teamRole,
      decision: 'task_reviewed',
      why: 'Task acceptance gate failed after rework limit.',
      policy_used: 'mission_orchestration_control_plane_v1',
      evidence: input.task.deliverable ? [String(input.task.deliverable)] : [],
      payload: {
        description: input.task.description,
        deliverable: input.task.deliverable,
        task_model_hint: input.assignment.model_hint,
        task_result: response.taskResult,
        task_result_retried: response.retried,
        gate_reasons: acceptance.reasons,
        gate_record_path: acceptance.recordPath,
        rework_count: nextReworkCount,
        rework_requested: false,
        ...taskResultObservability,
      },
    });
    emitMissionOrchestrationObservation({
      event_type: 'mission_owner_notified',
      decision: 'mission_owner_notified',
      mission_id: input.missionId,
      task_id: input.task.task_id,
      team_role: input.teamRole,
      reason: 'Task acceptance gate failed after rework limit.',
      gate_rework_count: nextReworkCount,
      gate_reasons: acceptance.reasons,
      gate_record_path: acceptance.recordPath,
    });
    // Escalation (escalation_parent_team_role): the observability record above
    // reaches no one by itself — deliver the rework-limit failure to the
    // operator so the cascade block is a decision point, not a silent stall.
    void notifyOperator('approval_required', {
      title: `Mission ${input.missionId}: task ${input.task.task_id} blocked at rework limit`,
      body: [
        `Acceptance gate failed twice for ${input.task.task_id} (role: ${input.teamRole}).`,
        `Reasons: ${acceptance.reasons.join('; ') || 'unspecified'}.`,
        `Dependent tasks are cascade-blocked. Options: replan via mission_controller resume ${input.missionId} after adjusting the task, or accept-with-override.`,
      ].join('\n'),
      correlation_id: `${input.missionId}:${input.task.task_id}:rework-limit`,
    });
    recordMissionContextTask(input.missionId, `Blocked work item ${input.task.task_id}`, {
      next_step: 'notify owner and request human intervention',
      work_item_id: input.task.task_id,
      team_role: input.teamRole,
      assignee_peer_id: input.assignment.agent_id,
      execution_mode: response.executionMode,
      context_pack_id: dispatchContext.missionContextPackId,
      context_pack_path: dispatchContext.missionContextPackPath,
      context_pack_summary: dispatchContext.missionContextPackSummary,
      context_pack_pruning_summary: dispatchContext.missionContextPackPruningSummary,
      gate_reasons: acceptance.reasons,
      gate_record_path: acceptance.recordPath,
      rework_count: nextReworkCount,
      ...taskResultObservability,
    });
    return {
      task_id: input.task.task_id,
      team_role: input.teamRole,
      agent_id: input.assignment.agent_id,
      dispatched: false,
      allowSameInvocationRedispatch: false,
      redispatchTaskIds: [],
      ...taskResultObservability,
    };
  }

  updateWorkItem({
    itemId: claimed.item.item_id,
    expectedVersion: claimed.item.version,
    status: 'done',
    metadata: {
      summary: response.taskResult?.summary || input.task.description || input.task.task_id,
      mission_id: input.missionId,
      task_id: input.task.task_id,
      team_role: input.teamRole,
      task_result_retried: response.retried,
    },
  });
  input.task.status = 'completed';
  let prRef: string | undefined;
  try {
    prRef = publishTaskPrArtifacts({
      missionId: input.missionId,
      task: input.task,
      teamRole: input.teamRole,
      taskResult: response.taskResult,
    });
  } catch (err: any) {
    logger.warn(
      `[MISSION_WORKER] PR artifact publication failed for ${input.task.task_id}: ${err?.message || err}`
    );
  }
  emitMissionTaskEvent({
    event_type: 'task_completed',
    mission_id: input.missionId,
    task_id: input.task.task_id,
    agent_id: input.assignment.agent_id,
    team_role: input.teamRole,
    decision: 'task_completed',
    why: 'Task acceptance gate passed.',
    policy_used: 'mission_orchestration_control_plane_v1',
    evidence: input.task.deliverable ? [String(input.task.deliverable)] : [],
    payload: {
      description: input.task.description,
      deliverable: input.task.deliverable,
      task_model_hint: input.assignment.model_hint,
      mission_context_pack_path: dispatchContext.missionContextPackPath,
      mission_context_pack_summary: dispatchContext.missionContextPackSummary,
      work_item_id: claimed.item.item_id,
      work_item_lease_id: claimed.lease.lease_id,
      work_item_status: claimed.item.status,
      task_result: response.taskResult,
      task_result_retried: response.retried,
      gate_record_path: acceptance.recordPath,
      ...(independentReview
        ? {
            independent_acceptance_review: {
              reviewer_agent_id: independentReview.reviewerAgentId,
              approve: independentReview.approve,
              ...(independentReview.rationale ? { rationale: independentReview.rationale } : {}),
            },
          }
        : {}),
      ...(prRef ? { pr_ref: prRef } : {}),
      ...taskResultObservability,
    },
  });
  recordMissionContextTask(input.missionId, `Completed work item ${input.task.task_id}`, {
    next_step: 'continue reconciliation and update the task board',
    task_id: input.task.task_id,
    team_role: input.teamRole,
    assignee_peer_id: input.assignment.agent_id,
    execution_mode: response.executionMode,
    context_pack_id: dispatchContext.missionContextPackId,
    context_pack_path: dispatchContext.missionContextPackPath,
    context_pack_summary: dispatchContext.missionContextPackSummary,
    context_pack_pruning_summary: dispatchContext.missionContextPackPruningSummary,
    work_item_id: claimed.item.item_id,
    work_item_lease_id: claimed.lease.lease_id,
    work_item_status: claimed.item.status,
    gate_record_path: acceptance.recordPath,
    ...taskResultObservability,
  });
  return {
    task_id: input.task.task_id,
    team_role: input.teamRole,
    agent_id: input.assignment.agent_id,
    dispatched: true,
    ...taskResultObservability,
  };
}

registerMissionWorkerCoreDispatcher(dispatchPlannedMissionTaskCore as any);
