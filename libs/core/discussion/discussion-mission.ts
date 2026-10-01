import { withExecutionContext } from '../authority.js';
import { createApprovalRequest, loadApprovalRequest } from '../governance/approval-store.js';
import { issueChronosMissionFromProposal } from '../surface/surface-mission-proposals.js';
import { loadArtifactRecord, saveArtifactRecord } from '../workforce/artifact-record.js';
import { getWorkItem, updateWorkItem } from '../workforce/work-coordination.js';
import { logger } from '../core.js';
import { fillCopy, loadDiscussionCopy } from './discussion-copy.js';
import {
  appendDiscussionEvent,
  DiscussionUserError,
  readDiscussionRoom,
} from './discussion-store.js';
import type { DiscussionRoomState } from './discussion-types.js';

/** Approvals raised by rooms live in the Chronos channel, next to every other Chronos approval. */
const APPROVAL_CHANNEL = 'chronos';

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * An accepted decision does not start a mission by itself. It raises an
 * approval request that a human decides in the normal approvals queue; only
 * an approved request lets `issueMissionForDiscussion` go through
 * mission_controller.
 */
export function requestMissionStart(roomId: string, actor: string): { approval_id: string } | null {
  const room = readDiscussionRoom(roomId);
  if (!room?.decision) throw new DiscussionUserError('The discussion has no decision yet');
  if (room.scope.mission_id) return null; // already part of a mission
  if (room.outcomes.mission?.approval_id) return { approval_id: room.outcomes.mission.approval_id };
  const locale = room.config.locale;
  const copy = loadDiscussionCopy().mission_request;
  // Mission ceremonies are written by mission_controller, the same governed role
  // the approval actuator uses; the Chronos gateway role cannot write this log.
  const request = withExecutionContext('mission_controller', () =>
    createApprovalRequest('mission_controller', {
      channel: APPROVAL_CHANNEL,
      threadTs: room.id,
      correlationId: `discussion:${room.id}`,
      requestedBy: actor,
      draft: {
        title: fillCopy(copy.title[locale], { title: clip(room.title, 80) }),
        summary: copy.summary[locale],
        details: fillCopy(copy.details[locale], {
          goal: room.goal,
          decision: room.decision.summary,
          brief: room.outcomes.brief?.path ?? '',
        }),
        severity: 'medium',
      },
      sourceText: room.goal,
      scope: {
        ...(room.scope.tenant_slug ? { tenant_slug: room.scope.tenant_slug } : {}),
        ...(room.scope.organization_id ? { organization_id: room.scope.organization_id } : {}),
        // The canonical chain forbids a project without its organization.
        ...(room.scope.organization_id && room.scope.project_id
          ? { project_id: room.scope.project_id }
          : {}),
      },
    })
  );
  appendDiscussionEvent(room.id, {
    type: 'mission_requested',
    approval_id: request.id,
    approval_channel: APPROVAL_CHANNEL,
    actor,
  });
  return { approval_id: request.id };
}

function approvalStatus(
  room: DiscussionRoomState
): 'pending' | 'approved' | 'rejected' | 'unknown' | undefined {
  const mission = room.outcomes.mission;
  if (!mission?.approval_id) return undefined;
  try {
    const record = loadApprovalRequest(mission.approval_channel, mission.approval_id);
    if (!record) return 'unknown';
    if (record.status === 'pending') return 'pending';
    if (record.status === 'rejected') return 'rejected';
    // approved / applied / failed all mean a human said yes.
    return 'approved';
  } catch {
    return 'unknown';
  }
}

/** The room as a viewer should see it: with the live status of its approval. */
export function withLiveMissionStatus(room: DiscussionRoomState): DiscussionRoomState {
  const status = approvalStatus(room);
  if (!status || !room.outcomes.mission) return room;
  return {
    ...room,
    outcomes: {
      ...room.outcomes,
      mission: { ...room.outcomes.mission, approval_status: status },
    },
  };
}

export interface IssueMissionResult {
  mission_id: string;
  orchestration_status: 'queued' | 'failed';
}

/**
 * Start the mission an approved request stands for — through
 * mission_controller — and thread it back: the room, its WorkItems and its
 * deliverables now carry the mission id.
 */
export async function issueMissionForDiscussion(
  roomId: string,
  actor: string
): Promise<IssueMissionResult> {
  const room = readDiscussionRoom(roomId);
  if (!room?.decision) throw new DiscussionUserError('The discussion has no decision yet');
  const mission = room.outcomes.mission;
  if (!mission?.approval_id)
    throw new DiscussionUserError('No mission start was requested for this discussion');
  if (mission.mission_id)
    throw new DiscussionUserError(`Mission already started: ${mission.mission_id}`);
  if (approvalStatus(room) !== 'approved') {
    throw new DiscussionUserError('The mission start has not been approved yet');
  }
  let issued: Awaited<ReturnType<typeof issueChronosMissionFromProposal>>;
  try {
    issued = await issueChronosMissionFromProposal({
      sessionId: `discussion-${room.id}`,
      proposal: {
        intent: 'create_mission',
        mission_type: 'development',
        summary: clip(room.decision.summary, 300),
        why: room.goal,
        tier: room.scope.tier ?? 'confidential',
      },
      sourceText: room.goal,
    });
  } catch (error) {
    // mission_controller refuses for real reasons (for instance an environment that
    // has not finished onboarding). Keep the details in the log; tell the person what to check.
    logger.error(
      `[discussion] mission_controller did not start a mission for ${room.id}: ${error instanceof Error ? error.message : String(error)}`
    );
    throw new DiscussionUserError(
      'mission_controller could not start the mission. Check that onboarding is complete (pnpm onboarding) and see the server log.',
      { cause: error }
    );
  }
  appendDiscussionEvent(room.id, {
    type: 'mission_started',
    mission_id: issued.missionId,
    actor,
  });
  linkMissionToOutputs(room, issued.missionId);
  return { mission_id: issued.missionId, orchestration_status: issued.orchestrationStatus };
}

function linkMissionToOutputs(room: DiscussionRoomState, missionId: string): void {
  for (const itemId of Object.values(room.outcomes.work_items)) {
    try {
      const item = getWorkItem(itemId);
      if (item) {
        updateWorkItem({
          itemId,
          context: { ...(item.context ?? {}), mission_id: missionId },
        });
      }
    } catch (error) {
      logger.warn(`[discussion] could not link ${itemId} to ${missionId}: ${String(error)}`);
    }
  }
  for (const artifact of [room.outcomes.minutes, room.outcomes.brief]) {
    if (!artifact) continue;
    try {
      const record = loadArtifactRecord(artifact.artifact_id);
      if (record) saveArtifactRecord({ ...record, mission_id: missionId });
    } catch (error) {
      logger.warn(
        `[discussion] could not link ${artifact.artifact_id} to ${missionId}: ${String(error)}`
      );
    }
  }
}
