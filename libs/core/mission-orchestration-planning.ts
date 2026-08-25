import * as nodePath from 'node:path';
import { a2aBridge } from './a2a-bridge.js';
import { logger } from './core.js';
import { emitChannelSurfaceEvent } from './surface-artifact-store.js';
import { emitMissionOrchestrationObservation } from './mission-orchestration-events.js';
import { missionDir, rootDir } from './path-resolver.js';
import { readJson } from './foundation/json.js';
import { reportProviderTemporarilyUnhealthy } from './provider-health-registry.js';
import { agentRegistry } from './agent-registry.js';
import {
  resolveMissionTeamPlan,
  resolveMissionTeamReceiver,
} from './mission-team-plan-composer.js';
import {
  buildPlannerKickoffPrompt,
  buildPlannerRetryPrompt,
  buildPlanningReviewPrompt,
  collectPlanningPacketTaskContractErrors,
  packetRequiresIndependentReview,
  parsePlanningReviewVerdict,
  type PlanningReviewVerdict,
} from './mission-planning-packet.js';
import { extractPlanningPacketBlocks } from './planning-packet-contract.js';
import { evaluateMissionGate } from './mission-gate-engine.js';
import { provisionMissionEntry, writeProvisionedJson } from './mission-orchestration-journal.js';
import { payloadSurface, type SlackPayload } from './mission-orchestration-worker-contracts.js';
import type { PlanningPacket } from './channel-surface.js';

export function emitSlackMissionEvent(
  payload: SlackPayload,
  missionId: string,
  decision: string,
  why: string,
  extra: Record<string, unknown> = {}
): void {
  // SN-01: slack keeps its dedicated channel stream; other surfaces record
  // into the mission-control stream (the only one the worker's
  // mission_controller identity may write). The historical name stays because
  // every orchestration handler calls through here.
  const surface = payloadSurface(payload);
  const event = {
    correlation_id: missionId,
    decision,
    why,
    policy_used: 'mission_orchestration_control_plane_v1',
    agent_id: 'mission_controller',
    resource_id: missionId,
    surface,
    surface_channel: payload.channel,
    thread_ts: payload.threadTs,
    ...extra,
  };
  if (surface === 'slack') {
    emitChannelSurfaceEvent('slack_bridge', 'slack', 'missions', {
      ...event,
      slack_channel: payload.channel,
    });
    return;
  }
  emitMissionOrchestrationObservation(event);
}

async function recordPlanningPacketGate(input: {
  missionId: string;
  packet: PlanningPacket;
  verdict: 'pass' | 'fail';
  reason?: string;
  reviewVerdict?: PlanningReviewVerdict;
  plannerAgentId: string;
  reviewerAgentId?: string;
  reviewRound: 0 | 1 | 2;
}): Promise<void> {
  const requiresIndependentReview = packetRequiresIndependentReview(input.packet);
  const reviewApproved =
    !requiresIndependentReview || input.reviewVerdict?.approve === true || input.verdict === 'fail';
  const evaluation = await evaluateMissionGate({
    missionId: input.missionId,
    gate: {
      id: `planning-packet-${input.missionId}`,
      title: `Planning packet gate for ${input.missionId}`,
      checks: [
        {
          kind: 'schema_valid',
          params: {
            schema: 'planning_packet',
            value: input.packet,
          },
        },
        {
          kind: 'custom',
          params: {
            evaluate: () => ({
              passed: input.verdict === 'pass' && reviewApproved,
              reason:
                input.reason ||
                (!reviewApproved
                  ? input.reviewVerdict?.gaps.join('; ') ||
                    input.reviewVerdict?.rationale ||
                    'planning review rejected the packet'
                  : undefined),
            }),
          },
        },
      ],
    },
    evidenceDir: `${missionDir(input.missionId, 'public')}/gates`,
  });
  if (evaluation.evidence_path) {
    const current = readJson<Record<string, unknown>>(evaluation.evidence_path);
    writeProvisionedJson({
      missionId: input.missionId,
      filePath: evaluation.evidence_path,
      targetPath: nodePath
        .relative(missionDir(input.missionId, 'public'), evaluation.evidence_path)
        .replaceAll(nodePath.sep, '/'),
      provisioned: provisionMissionEntry({
        ...current,
        planner_agent_id: input.plannerAgentId,
        ...(input.reviewerAgentId ? { reviewer_agent_id: input.reviewerAgentId } : {}),
        review_round: input.reviewRound,
        requires_independent_review: requiresIndependentReview,
        ...(input.reviewVerdict
          ? {
              review_verdict: {
                approve: input.reviewVerdict.approve,
                gaps: input.reviewVerdict.gaps,
                ...(input.reviewVerdict.rationale
                  ? { rationale: input.reviewVerdict.rationale }
                  : {}),
              },
            }
          : {}),
      }),
    });
  }
}

async function requestPlanningReviewText(
  missionId: string,
  payload: SlackPayload,
  reviewerAgentId: string,
  prompt: string
): Promise<string> {
  const response = await a2aBridge.route({
    a2a_version: '1.0',
    header: {
      msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-REVIEW`,
      sender: 'kyberion:mission-orchestrator',
      receiver: reviewerAgentId,
      performative: 'request',
      timestamp: new Date().toISOString(),
    },
    payload: {
      intent: 'mission_kickoff_plan_review',
      text: prompt,
      context: {
        channel: 'slack',
        slack_channel: payload.channel,
        thread: payload.threadTs,
        execution_mode: 'task',
        mission_id: missionId,
        team_role: 'reviewer',
      },
    },
  });
  return String(response.payload?.text || '');
}

// Top-level repo roots a task target may address directly; anything else
// relative is treated as mission-relative and anchored to the mission dir.
const REPO_RELATIVE_TARGET_ROOTS =
  /^(active|knowledge|outputs|customer|vault|work|pipelines|templates)\//;

/**
 * Anchor a mission-relative task target ('evidence/…') to the mission
 * directory as a repo-relative path so it is comparable with
 * allowed_write_scopes prefixes ('active/missions/…'). Absolute and
 * repo-relative targets pass through unchanged (absolute paths outside the
 * repo are then blocked by the scope check, which is the intent).
 */
export function resolveMissionRelativeTargetPath(
  missionId: string,
  value?: string
): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return normalized;
  if (REPO_RELATIVE_TARGET_ROOTS.test(normalized)) return normalized;
  const missionRepoRelative = nodePath
    .relative(rootDir(), missionDir(missionId, 'public'))
    .replace(/\\/g, '/');
  return `${missionRepoRelative}/${normalized.replace(/^\.\/+/, '')}`;
}

/**
 * Best-effort demotion of the backend behind a planner that failed to produce
 * a planning packet even after a retry. The provider comes from the live
 * agent registry when available, falling back to the staffed assignment.
 */
function reportDegradedPlannerBackend(
  missionId: string,
  plannerAgentId: string,
  reason: string
): void {
  try {
    const liveProvider = agentRegistry.get(plannerAgentId)?.provider;
    const staffedProvider = resolveMissionTeamReceiver({
      missionId,
      teamRole: 'planner',
    })?.provider;
    const provider = liveProvider || staffedProvider;
    if (!provider) return;
    reportProviderTemporarilyUnhealthy(provider, {
      reason:
        `planner ${plannerAgentId} on ${provider} returned no planning_packet after retry: ${reason}`.slice(
          0,
          200
        ),
    });
    logger.warn(
      `[MISSION_WORKER] Demoted provider ${provider} after degraded planner responses for ${missionId}.`
    );
  } catch {
    // Health reporting must never mask the original planner failure.
  }
}

async function requestPlanningPacketText(
  missionId: string,
  payload: SlackPayload,
  plannerAgentId: string,
  prompt: string
): Promise<string> {
  const response = await a2aBridge.route({
    a2a_version: '1.0',
    header: {
      msg_id: `REQ-${Date.now().toString(36).toUpperCase()}`,
      sender: 'kyberion:mission-orchestrator',
      receiver: plannerAgentId,
      performative: 'request',
      timestamp: new Date().toISOString(),
    },
    payload: {
      intent: 'mission_kickoff_planning',
      text: prompt,
      context: {
        channel: 'slack',
        slack_channel: payload.channel,
        thread: payload.threadTs,
        execution_mode: 'task',
        mission_id: missionId,
        team_role: 'planner',
      },
    },
  });
  return String(response.payload?.text || '');
}

export async function resolveMissionPlanningPacket(
  missionId: string,
  plan: ReturnType<typeof resolveMissionTeamPlan>,
  payload: SlackPayload,
  plannerAgentId: string,
  teamView: Record<string, unknown>
): Promise<PlanningPacket> {
  const kickoffPrompt = buildPlannerKickoffPrompt(missionId, plan, payload, teamView);
  let kickoffText = await requestPlanningPacketText(
    missionId,
    payload,
    plannerAgentId,
    kickoffPrompt
  );
  let kickoffBlocks = extractPlanningPacketBlocks(kickoffText);
  let planningPacket = kickoffBlocks.planningPackets[0];
  let reviewVerdict: PlanningReviewVerdict | undefined;

  if (!planningPacket) {
    const retryPrompt = buildPlannerRetryPrompt(
      missionId,
      kickoffBlocks.planningPacketErrors.length > 0
        ? kickoffBlocks.planningPacketErrors
        : ['missing planning_packet block'],
      kickoffText
    );
    kickoffText = await requestPlanningPacketText(missionId, payload, plannerAgentId, retryPrompt);
    kickoffBlocks = extractPlanningPacketBlocks(kickoffText);
    planningPacket = kickoffBlocks.planningPackets[0];
  }

  if (!planningPacket) {
    const failureDetail =
      kickoffBlocks.planningPacketErrors.length > 0
        ? kickoffBlocks.planningPacketErrors.join('; ')
        : 'no planning_packet block returned';
    // A planner that cannot produce a packet even after a retry is a degraded
    // backend signal (observed live as instant non-answers from a rate-limited
    // CLI). Report it into the shared provider-health registry so the next
    // resume/staffing fails over dynamically instead of retrying the same
    // backend forever.
    reportDegradedPlannerBackend(missionId, plannerAgentId, failureDetail);
    throw new Error(
      `Planner response for ${missionId} failed planning_packet validation after retry: ${failureDetail}`
    );
  }

  // Task-contract rules (reviewer review_target / dependency / deliverable) used to be
  // enforced only when NEXT_TASKS.json was re-read after persist, so a violation killed
  // the kickoff with no repair chance. Enforce them here so the planner gets one retry
  // with the concrete contract error before the packet is reviewed or persisted.
  const contractErrors = collectPlanningPacketTaskContractErrors(missionId, planningPacket);
  if (contractErrors.length > 0) {
    const contractRetryPrompt = buildPlannerRetryPrompt(missionId, contractErrors, kickoffText);
    kickoffText = await requestPlanningPacketText(
      missionId,
      payload,
      plannerAgentId,
      contractRetryPrompt
    );
    kickoffBlocks = extractPlanningPacketBlocks(kickoffText);
    const retriedPacket = kickoffBlocks.planningPackets[0];
    const retriedErrors = retriedPacket
      ? collectPlanningPacketTaskContractErrors(missionId, retriedPacket)
      : kickoffBlocks.planningPacketErrors.length > 0
        ? kickoffBlocks.planningPacketErrors
        : ['no planning_packet block returned'];
    if (!retriedPacket || retriedErrors.length > 0) {
      throw new Error(
        `Planner packet for ${missionId} violated the task contract after retry: ${retriedErrors.join('; ')}`
      );
    }
    planningPacket = retriedPacket;
  }

  let reviewerAgentId: string | undefined;
  if (packetRequiresIndependentReview(planningPacket)) {
    const reviewerAssignment = resolveMissionTeamReceiver({ missionId, teamRole: 'reviewer' });
    reviewerAgentId = reviewerAssignment?.agent_id || plannerAgentId;
    let reviewText = await requestPlanningReviewText(
      missionId,
      payload,
      reviewerAgentId,
      buildPlanningReviewPrompt({
        missionId,
        plan,
        payload,
        teamView,
        packet: planningPacket,
      })
    );
    reviewVerdict = parsePlanningReviewVerdict(reviewText);
    if (!reviewVerdict.approve) {
      const retryPrompt = buildPlannerRetryPrompt(
        missionId,
        reviewVerdict.gaps.length > 0
          ? reviewVerdict.gaps
          : [reviewVerdict.rationale || 'planning review rejected the packet'],
        kickoffText
      );
      kickoffText = await requestPlanningPacketText(
        missionId,
        payload,
        plannerAgentId,
        retryPrompt
      );
      kickoffBlocks = extractPlanningPacketBlocks(kickoffText);
      planningPacket = kickoffBlocks.planningPackets[0];
      if (!planningPacket) {
        throw new Error(
          `Planner response for ${missionId} failed planning_packet validation after review retry: ${
            kickoffBlocks.planningPacketErrors.length > 0
              ? kickoffBlocks.planningPacketErrors.join('; ')
              : 'no planning_packet block returned'
          }`
        );
      }
      const reviewRetryContractErrors = collectPlanningPacketTaskContractErrors(
        missionId,
        planningPacket
      );
      if (reviewRetryContractErrors.length > 0) {
        throw new Error(
          `Planner packet for ${missionId} violated the task contract after review retry: ${reviewRetryContractErrors.join('; ')}`
        );
      }

      reviewText = await requestPlanningReviewText(
        missionId,
        payload,
        reviewerAgentId,
        buildPlanningReviewPrompt({
          missionId,
          plan,
          payload,
          teamView,
          packet: planningPacket,
          plannerFeedback: reviewVerdict.gaps,
        })
      );
      reviewVerdict = parsePlanningReviewVerdict(reviewText);
      if (!reviewVerdict.approve) {
        await recordPlanningPacketGate({
          missionId,
          packet: planningPacket,
          verdict: 'fail',
          reason:
            reviewVerdict.gaps.length > 0
              ? reviewVerdict.gaps.join('; ')
              : reviewVerdict.rationale || 'planning review rejected packet',
          reviewVerdict,
          plannerAgentId,
          reviewerAgentId,
          reviewRound: 2,
        });
        throw new Error(
          `Planning review rejected packet for ${missionId}: ${
            reviewVerdict.gaps.length > 0
              ? reviewVerdict.gaps.join('; ')
              : reviewVerdict.rationale || 'no review gaps returned'
          }`
        );
      }
    }
  }

  await recordPlanningPacketGate({
    missionId,
    packet: planningPacket,
    verdict: 'pass',
    plannerAgentId,
    reviewRound: packetRequiresIndependentReview(planningPacket) ? 2 : 1,
    ...(reviewerAgentId ? { reviewerAgentId } : {}),
    ...(reviewVerdict ? { reviewVerdict } : {}),
  });

  return planningPacket;
}
