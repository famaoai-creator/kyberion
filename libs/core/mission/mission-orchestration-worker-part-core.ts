import { AgentBusyError } from '../mesh/a2a-bridge.js';
import * as path from 'node:path';
import { notifyOperator } from '../surface/operator-notifications.js';
import { type DelegationChain } from './delegation-chain.js';
import { missionCoordinationBus } from './mission-coordination-bus.js';
import {
  claimWorkItem,
  importExternalWorkItem,
  listWorkItems,
  releaseWorkItem,
  updateWorkItem,
} from '../workforce/work-coordination.js';
import { logger } from '../core.js';
import { canonicalizeTeamRole } from '../working-principles.js';
import { TraceContext } from '../analysis/trace.js';
import { nowIso } from '../foundation/time.js';
import { type GapRecorder } from '../gap-phase.js';
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
import { isPromptTooLongError } from '../workforce/worker-context-compaction.js';

import {
  recordMissionContextTask,
  recordMissionVisiblePrompt,
  taskClarificationFilePath,
  summarizeTaskResultObservability,
  buildTaskClarificationPacket,
  takeTaskCustomerDecisions,
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
  CUSTOMER_DECISION_TIER_MISMATCH,
} from './mission-orchestration-worker-part-dispatch-context.js';
import type { ConfidentialTaskDecisionValues } from '../customer-decision/task-decision-values.js';
import type { TaskResultBlock } from './mission-orchestration-worker-contracts.js';
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
import {
  auditTaskDecisionDelivery,
  pinTaskDecisions,
  reconcileTaskDecisions,
  recordTaskDecisionProposals,
  CUSTOMER_DECISION_BLOCKED_REASONS,
} from './mission-decision-lock.js';

/**
 * CD-09: replace echoed customer decision values in the worker's own words
 * (summary, needs, gaps, verification, review instructions, notes) before
 * any copy of them reaches a store that is not tenant-partitioned.
 */
function scrubTaskResultValues(
  values: ConfidentialTaskDecisionValues,
  taskResult: TaskResultBlock | undefined,
  notes: string[] | undefined
): void {
  if (notes) notes.splice(0, notes.length, ...notes.map((note) => values.scrub(note)));
  if (!taskResult) return;
  const scrubList = (list: string[] | undefined) =>
    Array.isArray(list) ? list.map((entry) => values.scrub(String(entry))) : list;
  taskResult.summary = values.scrub(String(taskResult.summary || ''));
  taskResult.needs = scrubList(taskResult.needs) ?? [];
  taskResult.gaps = scrubList(taskResult.gaps) ?? [];
  taskResult.verification_done = scrubList(taskResult.verification_done) ?? [];
  if (Array.isArray(taskResult.review_findings)) {
    taskResult.review_findings = taskResult.review_findings.map((finding) => ({
      ...finding,
      instruction: values.scrub(String(finding.instruction || '')),
    }));
  }
}

export async function dispatchPlannedMissionTaskCore(
  input: DispatchPlannedMissionTaskInput,
  traceCtx: TraceContext,
  delegationChain?: DelegationChain,
  gapRecorder?: GapRecorder
): Promise<DispatchMissionTaskOutcome | null> {
  const workItemSourceRef = `mission:${input.missionId}:${input.task.task_id}`;
  // D2: re-imports of the same sourceRef replace the stored context, so merge
  // onto the already-normalized context instead of clobbering project_id /
  // work_shape that createWorkItem filled in on first dispatch.
  const previousWorkItem = listWorkItems({ source: 'local' }).find(
    (entry) => entry.source_ref === workItemSourceRef
  );
  const workItem = importExternalWorkItem({
    source: 'local',
    sourceRef: workItemSourceRef,
    title: input.task.description || input.task.task_id,
    description: input.task.description || input.task.task_id,
    status: 'ready',
    priority: 'normal',
    projectId: input.missionId,
    assigneePeerId: input.assignment.agent_id,
    // D2: `mission:<id>` / `team_role:<role>` labels stay as display-only
    // markers (taxonomy: knowledge/product/schemas/workitem-label-taxonomy.schema.json).
    // Typed `context` is written alongside so search / restoration paths resolve
    // via `context.mission_id` without depending on label strings.
    labels: [`mission:${input.missionId}`, `team_role:${input.teamRole}`],
    context: {
      ...(previousWorkItem?.context || {}),
      mission_id: input.missionId,
      task_id: input.task.task_id,
    },
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
  // CD-09: pin the customer decisions this task starts on (no-op without a decision case).
  const decisionPin = pinTaskDecisions({
    missionId: input.missionId,
    taskId: input.task.task_id,
    mode: 'start',
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
  // CD-09: a resumed task's confirmed customer decisions (held in memory only).
  const decisionValues = decisionPin?.decision_values;
  let decisionsAudited = false;
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
      ...(decisionValues ? { customerDecisionValues: decisionValues } : {}),
    });
  type BuiltDispatchContext = Awaited<ReturnType<typeof buildTaskDispatchContext>>;
  /**
   * CD-09: the tier gate withheld the values: the task is not dispatched (the
   * values are never sent) and its WorkItem is blocked, ids only.
   */
  const blockOnDecisionTier = (context: BuiltDispatchContext): DispatchMissionTaskOutcome => {
    const delivery = context.customerDecisionDelivery;
    const decisionIds = delivery?.decision_ids ?? [];
    const reason = delivery?.reason ?? 'tier_gate';
    if (decisionValues) {
      auditTaskDecisionDelivery({
        values: decisionValues,
        missionId: input.missionId,
        taskId: input.task.task_id,
        operation: 'task_decisions_withheld',
        reason,
      });
    }
    const hold = {
      status: 'tier_mismatch',
      ...(decisionValues
        ? { consumer: decisionValues.consumer, case_id: decisionValues.caseId }
        : {}),
      decision_ids: decisionIds,
      reason,
      next: `run the task in a confidential mission of the decision case's tenant, then pnpm mission resume ${input.missionId}`,
    };
    updateWorkItem({
      itemId: claimed.item.item_id,
      expectedVersion: claimed.item.version,
      status: 'blocked',
      metadata: {
        summary:
          'Task blocked: its confirmed customer decisions may not be sent in this mission’s context',
        blocked_reason: CUSTOMER_DECISION_TIER_MISMATCH,
        mission_id: input.missionId,
        task_id: input.task.task_id,
        team_role: input.teamRole,
        customer_decision_hold: hold,
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
      why: 'The mission context may not carry the confidential customer decisions this task needs.',
      policy_used: 'mission_orchestration_control_plane_v1',
      evidence: [],
      payload: { customer_decision_hold: hold },
    });
    recordMissionContextTask(input.missionId, `Blocked work item ${input.task.task_id}`, {
      next_step: hold.next,
      work_item_id: input.task.task_id,
      team_role: input.teamRole,
      assignee_peer_id: input.assignment.agent_id,
      context_pack_id: context.missionContextPackId,
      context_pack_path: context.missionContextPackPath,
    });
    return {
      task_id: input.task.task_id,
      team_role: input.teamRole,
      agent_id: input.assignment.agent_id,
      dispatched: false,
      ...summarizeTaskResultObservability({
        pruning: context.missionContextPackPruningSummary,
        parseErrors: [],
      }),
    };
  };
  /** CD-09: audit (once) and record, ids only, that the values went into the prompt. */
  const noteDecisionsDelivered = (context: BuiltDispatchContext) => {
    if (!decisionValues || context.customerDecisionDelivery?.status !== 'delivered') return;
    if (decisionsAudited) return;
    decisionsAudited = true;
    auditTaskDecisionDelivery({
      values: decisionValues,
      missionId: input.missionId,
      taskId: input.task.task_id,
      operation: 'task_decisions_delivered',
    });
    try {
      recordMissionVisiblePrompt({
        missionId: input.missionId,
        taskId: input.task.task_id,
        content: decisionValues.promptLines().join('\n'),
        form: 'customer_decision_values',
        ...(context.missionContextPackId ? { contextPackId: context.missionContextPackId } : {}),
        knowledgeRefs: decisionValues.knowledgeRefs().map((ref) => ({ path: ref })),
        securityScope: context.securityScope,
      });
    } catch (error) {
      logger.warn(
        `customer decision prompt visibility not recorded — ${error instanceof Error ? error.name : 'error'} | the task goes on | mission=${input.missionId} consumer=${decisionValues.consumer}`
      );
    }
  };
  const dispatchOnce = (context: BuiltDispatchContext) => {
    noteDecisionsDelivered(context);
    const dispatchArgs = {
      missionId: input.missionId,
      task: input.task,
      teamRole: input.teamRole,
      agentId: input.assignment.agent_id,
      taskModelHint: input.assignment.model_hint,
      provider: input.assignment.provider || undefined,
      providerModelId: input.assignment.modelId || undefined,
      requestedSelection: input.assignment.requested_selection,
      selectionResolution: input.assignment.selection_resolution,
      requiredCapabilities: input.assignment.required_capabilities,
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
    if (dispatchContext.customerDecisionDelivery?.status === 'withheld') {
      return blockOnDecisionTier(dispatchContext);
    }
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
      if (dispatchContext.customerDecisionDelivery?.status === 'withheld') {
        return blockOnDecisionTier(dispatchContext);
      }
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
  // CD-09: echoed customer decision values never leave in the worker's words.
  if (decisionValues) scrubTaskResultValues(decisionValues, response.taskResult, response.notes);
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
  // CD-09: customer-judgment questions leave the result here, before any of it
  // is stored, and go to the task's own lock in the confidential decision
  // case. The task goes on with its proposals; a requires_customer question
  // holds it. Without a decision case they are ordinary questions: the
  // requires_customer ones become needs, the others go on with the proposal.
  const customerDecisionRequests = takeTaskCustomerDecisions(response.taskResult);
  // Every structured result answers to the task's holds, even one with no
  // questions: a resumed task whose requires_customer question is still open
  // stays held instead of completing on what the worker happened to repeat.
  const decisionProposals =
    response.taskResult || customerDecisionRequests.length > 0
      ? recordTaskDecisionProposals({
          missionId: input.missionId,
          taskId: input.task.task_id,
          requests: customerDecisionRequests,
          workItemId: claimed.item.item_id,
        })
      : null;
  if (decisionProposals && !decisionProposals.case_found && response.taskResult) {
    const heldQuestions = customerDecisionRequests
      .filter((request) => request.requires_customer)
      .map((request) => request.question);
    if (heldQuestions.length > 0) {
      response.taskResult.needs = [...(response.taskResult.needs || []), ...heldQuestions];
    }
  }
  const taskResultNeeds = response.taskResult?.needs || [];
  const dispatchCanonicalTeamRole = canonicalizeTeamRole(input.teamRole);
  const reviewTarget = resolveReviewTargetForTask(input.task);
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
        written_at: nowIso(),
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

  // CD-09: a requires_customer question holds the task until the customer
  // decides (the needs → blocked path). Public evidence: ids and counts only.
  // Fail closed, but say so: a check that failed on a known case, or a case
  // lookup that failed for a task already held, blocks with a reason of its
  // own (customer_decision_check_failed) so it is told apart from a real wait.
  const previousBlockedReason = previousWorkItem?.metadata?.blocked_reason;
  const decisionCheckFailed = Boolean(
    decisionProposals &&
    ((decisionProposals.case_found && decisionProposals.failed) ||
      (decisionProposals.lookup_failed &&
        typeof previousBlockedReason === 'string' &&
        CUSTOMER_DECISION_BLOCKED_REASONS.includes(previousBlockedReason)))
  );
  if (decisionCheckFailed) {
    logger.warn(
      `task ${input.task.task_id} blocked — its customer decision holds could not be checked (customer_decision_check_failed) | resume the mission once the decision case is readable | mission=${input.missionId} consumer=${decisionProposals?.consumer ?? ''}`
    );
  }
  if (
    decisionProposals &&
    (decisionCheckFailed ||
      (decisionProposals.case_found && decisionProposals.hold_proposal_ids.length > 0))
  ) {
    const hold = {
      consumer: decisionProposals.consumer,
      ...(decisionProposals.case_id ? { case_id: decisionProposals.case_id } : {}),
      recorded_count: decisionProposals.recorded,
      hold_count: decisionProposals.hold_proposal_ids.length,
      hold_proposal_ids: decisionProposals.hold_proposal_ids,
      ...(decisionProposals.failed ? { recorded: false } : {}),
      ...(decisionProposals.lookup_failed ? { case_lookup_failed: true } : {}),
    };
    updateWorkItem({
      itemId: claimed.item.item_id,
      expectedVersion: claimed.item.version,
      status: 'blocked',
      metadata: {
        summary: decisionCheckFailed
          ? 'Task blocked: its customer decision holds could not be checked'
          : 'Task waits for a customer decision',
        blocked_reason: decisionCheckFailed
          ? 'customer_decision_check_failed'
          : 'awaiting_customer_decision',
        mission_id: input.missionId,
        task_id: input.task.task_id,
        team_role: input.teamRole,
        customer_decision_hold: {
          status: decisionCheckFailed ? 'check_failed' : 'awaiting',
          ...hold,
        },
      },
    });
    const holdPath = taskClarificationFilePath(input.missionId, input.task.task_id);
    writeProvisionedJson({
      missionId: input.missionId,
      filePath: holdPath,
      targetPath: `evidence/task-clarification-${input.task.task_id}.json`,
      missionPathHint: path.dirname(path.dirname(holdPath)),
      provisioned: provisionMissionEntry({
        mission_id: input.missionId,
        task_id: input.task.task_id,
        status: decisionCheckFailed
          ? 'customer_decision_check_failed'
          : 'awaiting_customer_decision',
        customer_decision_hold: hold,
        written_at: nowIso(),
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
      why: 'Task waits for a customer decision (requires_customer) before it can complete.',
      policy_used: 'mission_orchestration_control_plane_v1',
      evidence: input.task.deliverable ? [String(input.task.deliverable)] : [],
      payload: {
        description: input.task.description,
        deliverable: input.task.deliverable,
        clarification_packet_path: holdPath,
        customer_decision_hold: hold,
        ...taskResultObservability,
      },
    });
    recordMissionContextTask(input.missionId, `Blocked work item ${input.task.task_id}`, {
      next_step:
        'collect the task proposals into an agenda (customer-decision draft --from-tasks), send it, and resume the mission once the customer decision is confirmed',
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

  // CD-09: reconcile the pin at the task boundary. A stale result still
  // completes; the rework WorkItem carries the follow-up.
  const decisionCheck = reconcileTaskDecisions({
    missionId: input.missionId,
    taskId: input.task.task_id,
  });
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
      ...(decisionCheck.consumer
        ? {
            customer_decision_lock: {
              consumer: decisionCheck.consumer,
              ...(decisionPin ? { pinned_count: decisionPin.pinned_count } : {}),
              checked: decisionCheck.checked,
              stale_count: decisionCheck.stale_count,
              rework_work_item_ids: decisionCheck.rework_work_item_ids,
            },
          }
        : {}),
      ...(decisionProposals?.case_found && decisionProposals.recorded > 0
        ? {
            customer_decision_proposals: {
              consumer: decisionProposals.consumer,
              recorded_count: decisionProposals.recorded,
              proposal_ids: decisionProposals.proposal_ids,
            },
          }
        : {}),
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

// Unexported replace key: only this module can supersede its own registration
// when it is evaluated a second time against the same dispatch port (see
// registerMissionWorkerCoreDispatcher). It is a registry symbol because a
// second evaluation must present the same key; it is not a security boundary,
// and every supersede is logged.
const BUILTIN_DISPATCHER_REPLACE_KEY = Symbol.for(
  'kyberion.mission-orchestration-worker-part-core.builtin-dispatcher'
);

registerMissionWorkerCoreDispatcher(
  dispatchPlannedMissionTaskCore as any,
  {
    provenance: 'builtin',
    source: 'libs/core/mission/mission-orchestration-worker-part-core.ts',
    reason: 'builtin mission worker core dispatcher',
  },
  { replaceKey: BUILTIN_DISPATCHER_REPLACE_KEY }
);
