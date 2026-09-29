import { randomUUID } from 'node:crypto';
import { fillCopy, loadDiscussionCopy } from './discussion-copy.js';
import { requestMissionStart } from './discussion-mission.js';
import {
  createWorkItemsFromDecision,
  refreshDiscussionDeliverables,
} from './discussion-outcomes.js';
import {
  appendDiscussionEvent,
  DiscussionUserError,
  readDiscussionRoom,
} from './discussion-store.js';
import type {
  DiscussionReviewVerdict,
  DiscussionRoomState,
  DiscussionWorkProposal,
} from './discussion-types.js';

const PRIORITIES = new Set<DiscussionWorkProposal['priority']>(['low', 'normal', 'high']);
const REOPEN_EXTRA_ROUNDS = 2;
const NOTE_MAX = 1000;

export interface ProposalEditInput {
  id: string;
  title?: string;
  priority?: string;
  owner_role?: string | null;
  included?: boolean;
}

export interface ReviewInput {
  verdict: DiscussionReviewVerdict;
  note?: string;
  edits?: ProposalEditInput[];
  request_mission?: boolean;
}

export interface ReviewResult {
  verdict: DiscussionReviewVerdict;
  created_work_items: Array<{ proposal_id: string; item_id: string }>;
  mission_approval_id?: string;
  /** Set when the accept went through but raising the mission approval failed. */
  mission_error?: string;
  /** Request-changes puts the room back to work; the caller must restart its engine. */
  reopened: boolean;
}

/** Only known proposals and known values survive; anything else is dropped, never trusted. */
function sanitizeEdits(room: DiscussionRoomState, edits: ProposalEditInput[] | undefined) {
  const known = new Map(room.outcomes.proposals.map((p) => [p.id, p]));
  const roles = new Set(room.participants.map((p) => p.role));
  const clean: NonNullable<
    Extract<Parameters<typeof appendDiscussionEvent>[1], { type: 'proposals_edited' }>['edits']
  > = [];
  for (const edit of edits ?? []) {
    if (!known.has(edit.id)) continue;
    const next: (typeof clean)[number] = { id: edit.id };
    if (typeof edit.title === 'string' && edit.title.trim())
      next.title = edit.title.trim().slice(0, 100);
    if (edit.priority && PRIORITIES.has(edit.priority as DiscussionWorkProposal['priority'])) {
      next.priority = edit.priority as DiscussionWorkProposal['priority'];
    }
    if (edit.owner_role === null || edit.owner_role === '') next.owner_role = null;
    else if (typeof edit.owner_role === 'string' && roles.has(edit.owner_role))
      next.owner_role = edit.owner_role;
    if (typeof edit.included === 'boolean') next.included = edit.included;
    clean.push(next);
  }
  return clean;
}

/**
 * The human decision on a decision brief.
 *
 * - accept: apply the reviewer's edits, turn the kept proposals into WorkItems,
 *   and (unless the room already belongs to a mission) raise the mission-start
 *   approval request.
 * - request-changes: the note goes back into the room and it takes more rounds.
 * - reject: recorded; no work is created.
 */
export function reviewDiscussion(roomId: string, actor: string, input: ReviewInput): ReviewResult {
  const room = readDiscussionRoom(roomId);
  if (!room?.decision)
    throw new DiscussionUserError('The discussion has no decision to review yet');
  if (room.outcomes.review)
    throw new DiscussionUserError('This decision has already been reviewed');
  const note = input.note?.trim().slice(0, NOTE_MAX) || undefined;
  if (input.verdict === 'request-changes' && !note) {
    throw new DiscussionUserError('A comment is required to send the decision back');
  }

  const edits = sanitizeEdits(room, input.edits);
  if (edits.length > 0) appendDiscussionEvent(room.id, { type: 'proposals_edited', actor, edits });

  const result: ReviewResult = { verdict: input.verdict, created_work_items: [], reopened: false };

  if (input.verdict === 'accept') {
    const created = createWorkItemsFromDecision(room.id, actor);
    result.created_work_items = created.created;
    appendDiscussionEvent(room.id, {
      type: 'review_recorded',
      actor,
      verdict: 'accept',
      ...(note ? { note } : {}),
    });
    if (input.request_mission) {
      // The decision is already accepted and its WorkItems exist; a failure to raise
      // the approval must not undo that, so it is reported rather than thrown.
      try {
        const mission = requestMissionStart(room.id, actor);
        if (mission) result.mission_approval_id = mission.approval_id;
      } catch (error) {
        result.mission_error = error instanceof Error ? error.message : String(error);
      }
    }
    refreshDiscussionDeliverables(room.id);
    return result;
  }

  if (input.verdict === 'reject') {
    appendDiscussionEvent(room.id, {
      type: 'review_recorded',
      actor,
      verdict: 'reject',
      ...(note ? { note } : {}),
    });
    refreshDiscussionDeliverables(room.id);
    return result;
  }

  // request-changes: record it, then put the room back to work on the note.
  const copy = loadDiscussionCopy().mission_request;
  appendDiscussionEvent(room.id, {
    type: 'review_recorded',
    actor,
    verdict: 'request-changes',
    note,
  });
  appendDiscussionEvent(room.id, {
    type: 'reopened',
    actor,
    note: note as string,
    extra_rounds: REOPEN_EXTRA_ROUNDS,
  });
  appendDiscussionEvent(room.id, {
    type: 'human_message',
    id: `hum-${randomUUID().slice(0, 10)}`,
    actor,
    text: note as string,
    round: Math.max(1, room.round),
  });
  appendDiscussionEvent(room.id, {
    type: 'agenda_set',
    agenda: [
      {
        id: `ag-review-${room.last_seq}`,
        title: fillCopy(copy.reopen_agenda[room.config.locale], {
          note: (note as string).slice(0, 100),
        }),
        status: 'active',
      },
      ...room.agenda.map((item) => ({ ...item, status: 'pending' as const })),
    ],
  });
  appendDiscussionEvent(room.id, {
    type: 'phase_changed',
    phase: 'exploring',
    round: room.round + 1,
  });
  result.reopened = true;
  return result;
}
