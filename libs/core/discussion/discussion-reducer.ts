import type {
  DialogueGoalState,
  DiscussionEvent,
  DiscussionRoomState,
  DiscussionRoomSummary,
  DiscussionVoteView,
} from './discussion-types.js';
import { DEFAULT_DISCUSSION_CONFIG } from './discussion-types.js';

function emptyState(id: string): DiscussionRoomState {
  return {
    id,
    title: '',
    goal: '',
    scope: {},
    config: { ...DEFAULT_DISCUSSION_CONFIG },
    created_by: '',
    created_at: '',
    updated_at: '',
    status: 'forming',
    phase: 'forming',
    round: 0,
    participants: [],
    staffing_gaps: [],
    roster_source: 'rules',
    agenda: [],
    messages: [],
    speaking: null,
    consensus: 0,
    consensus_history: [],
    open_issues: [],
    agreements: [],
    summaries: [],
    stance_by_speaker: {},
    message_counts: {},
    votes: [],
    decision: null,
    dialogue: {
      objective: '',
      success_criteria: [],
      constraints: [],
      assumptions: [],
      decisions: [],
      questions: [],
      readiness: 0,
      ready: false,
    },
    attachments: [],
    archived: false,
    stalled_for: null,
    outcomes: {
      proposals: [],
      minutes: null,
      work_items: {},
      brief: null,
      review: null,
      mission: null,
    },
    pending_commands: [],
    last_seq: 0,
  };
}

function tallyVote(vote: DiscussionVoteView): void {
  const tally: Record<string, number> = {};
  for (const option of vote.options) tally[option] = 0;
  for (const ballot of Object.values(vote.ballots)) {
    tally[ballot.choice] = (tally[ballot.choice] ?? 0) + 1;
  }
  vote.tally = tally;
}

const READY_THRESHOLD = 0.8;
/** How many blocking questions a dialogue is expected to settle before drafting a brief. */
const EXPECTED_BLOCKING = 4;

/**
 * Deterministic readiness: the objective, success criteria, constraints or
 * assumptions, at least one decision, and the blocking questions answered.
 * It is what the progress pane shows and what gates "draft the brief".
 */
export function computeDialogueReadiness(
  goal: Pick<
    DialogueGoalState,
    'objective' | 'success_criteria' | 'constraints' | 'assumptions' | 'decisions' | 'questions'
  >
): { readiness: number; ready: boolean } {
  const blocking = goal.questions.filter((q) => q.blocking);
  const resolved = blocking.filter((q) => q.status === 'resolved').length;
  const open = blocking.length - resolved;
  let score = 0;
  if (goal.objective) score += 0.2;
  if (goal.success_criteria.length > 0) score += 0.2;
  if (goal.constraints.length + goal.assumptions.length > 0) score += 0.15;
  if (goal.decisions.length > 0) score += 0.15;
  score += 0.3 * Math.min(1, resolved / Math.max(EXPECTED_BLOCKING, blocking.length));
  const readiness = Number(Math.min(1, score).toFixed(2));
  return { readiness, ready: readiness >= READY_THRESHOLD && open === 0 };
}

/** Pure projection of the event log into the state every surface renders. */
export function reduceDiscussionRoom(
  id: string,
  events: readonly DiscussionEvent[]
): DiscussionRoomState {
  const state = emptyState(id);
  const superseded = new Set<string>();
  for (const event of events) {
    if (event.type === 'message_superseded') for (const target of event.ids) superseded.add(target);
  }
  for (const event of events) {
    state.last_seq = event.seq;
    state.updated_at = event.ts;
    switch (event.type) {
      case 'room_created':
        state.title = event.title;
        state.goal = event.goal;
        state.scope = event.scope;
        state.config = { ...DEFAULT_DISCUSSION_CONFIG, ...event.config };
        state.created_by = event.created_by;
        state.created_at = event.ts;
        break;
      case 'team_formed':
        state.participants = event.participants;
        state.staffing_gaps = event.gaps;
        state.roster_source = event.roster_source ?? 'rules';
        break;
      case 'agenda_set':
        state.agenda = event.agenda;
        break;
      case 'phase_changed':
        state.phase = event.phase;
        state.round = event.round;
        if (event.phase === 'framing' || event.phase === 'exploring') state.status = 'running';
        break;
      case 'turn_started':
        state.speaking = event.speaker;
        if (event.agenda_id) {
          state.agenda = state.agenda.map((item) =>
            item.id === event.agenda_id
              ? { ...item, status: 'active' }
              : item.status === 'active'
                ? { ...item, status: 'done' }
                : item
          );
        }
        break;
      case 'message': {
        const isSuperseded = superseded.has(event.id);
        state.speaking = null;
        state.messages.push({
          id: event.id,
          kind: 'agent',
          speaker: event.speaker,
          text: event.text,
          ts: event.ts,
          performative: event.performative,
          stance: event.stance,
          ...(event.reply_to ? { reply_to: event.reply_to } : {}),
          ...(event.mentions?.length ? { mentions: event.mentions } : {}),
          ...(event.suggestions?.length ? { suggestions: event.suggestions } : {}),
          ...(event.consulted ? { consulted: true } : {}),
          ...(isSuperseded ? { superseded: true } : {}),
          round: event.round,
        });
        if (!event.consulted && !isSuperseded) state.stalled_for = null;
        if (!isSuperseded) {
          state.stance_by_speaker[event.speaker] = event.stance;
          state.message_counts[event.speaker] = (state.message_counts[event.speaker] ?? 0) + 1;
        }
        break;
      }
      case 'human_message':
        state.stalled_for = null;
        state.messages.push({
          id: event.id,
          kind: 'human',
          speaker: event.actor,
          text: event.text,
          ts: event.ts,
          ...(event.target ? { mentions: [event.target] } : {}),
          ...(event.attachments?.length ? { attachments: event.attachments } : {}),
          ...(superseded.has(event.id) ? { superseded: true } : {}),
          round: event.round,
        });
        break;
      case 'facilitator_summary':
        state.consensus = event.consensus;
        state.consensus_history.push({ round: event.round, value: event.consensus });
        state.open_issues = event.open_issues;
        state.agreements = event.agreements;
        state.summaries.push({ round: event.round, summary: event.summary, ts: event.ts });
        break;
      case 'command':
        state.pending_commands.push({
          id: event.id,
          actor: event.actor,
          command: event.command,
          ts: event.ts,
        });
        break;
      case 'command_ack':
        state.pending_commands = state.pending_commands.filter((c) => c.id !== event.command_id);
        break;
      case 'status_changed':
        state.status = event.status;
        state.status_reason = event.reason;
        if (event.status !== 'running') state.speaking = null;
        break;
      case 'vote_opened':
        state.votes.push({
          id: event.id,
          question: event.question,
          options: event.options,
          eligible: event.eligible,
          ballots: {},
          status: 'open',
          tally: Object.fromEntries(event.options.map((option) => [option, 0])),
        });
        break;
      case 'vote_cast': {
        const vote = state.votes.find((v) => v.id === event.vote_id);
        if (vote && vote.status === 'open') {
          vote.ballots[event.voter] = { choice: event.choice, kind: event.kind };
          tallyVote(vote);
        }
        break;
      }
      case 'vote_closed': {
        const vote = state.votes.find((v) => v.id === event.vote_id);
        if (vote) {
          vote.status = 'closed';
          vote.tally = event.tally;
          if (event.winner) vote.winner = event.winner;
        }
        break;
      }
      case 'decision':
        state.decision = event;
        state.phase = 'concluded';
        state.status = 'concluded';
        state.speaking = null;
        state.agenda = state.agenda.map((item) => ({ ...item, status: 'done' }));
        break;
      case 'outcomes_proposed':
        state.outcomes.proposals = event.proposals;
        break;
      case 'minutes_published':
        state.outcomes.minutes = {
          artifact_id: event.artifact_id,
          path: event.path,
          kind: event.kind,
        };
        break;
      case 'brief_published':
        state.outcomes.brief = { artifact_id: event.artifact_id, path: event.path };
        break;
      case 'workitems_created':
        for (const link of event.links) state.outcomes.work_items[link.proposal_id] = link.item_id;
        break;
      case 'proposals_edited':
        state.outcomes.proposals = state.outcomes.proposals.map((proposal) => {
          const edit = event.edits.find((e) => e.id === proposal.id);
          if (!edit) return proposal;
          const next = { ...proposal };
          if (edit.title !== undefined) next.title = edit.title;
          if (edit.priority !== undefined) next.priority = edit.priority;
          if (edit.included !== undefined) next.included = edit.included;
          if (edit.owner_role !== undefined) {
            if (edit.owner_role) next.owner_role = edit.owner_role;
            else delete next.owner_role;
          }
          return next;
        });
        break;
      case 'review_recorded':
        state.outcomes.review = {
          verdict: event.verdict,
          ...(event.note ? { note: event.note } : {}),
          actor: event.actor,
          ts: event.ts,
        };
        break;
      case 'reopened':
        // The room takes another round on the reviewer's note; the decision is
        // reset so the next conclusion (and its proposals) replaces this one.
        state.decision = null;
        state.status = 'running';
        state.phase = 'exploring';
        state.outcomes.proposals = [];
        state.outcomes.review = null;
        state.config = {
          ...state.config,
          max_rounds: Math.max(state.config.max_rounds, state.round + event.extra_rounds),
          max_messages: Math.max(state.config.max_messages, state.messages.length + 24),
        };
        break;
      case 'mission_requested':
        state.outcomes.mission = {
          approval_id: event.approval_id,
          approval_channel: event.approval_channel,
        };
        break;
      case 'mission_started':
        if (state.outcomes.mission) state.outcomes.mission.mission_id = event.mission_id;
        else
          state.outcomes.mission = {
            approval_id: '',
            approval_channel: '',
            mission_id: event.mission_id,
          };
        break;
      case 'goal_patched': {
        if (event.for_message && superseded.has(event.for_message)) break;
        const goal = state.dialogue;
        if (event.objective) goal.objective = event.objective;
        const add = (list: string[], items?: string[]) => {
          for (const item of items ?? []) if (item && !list.includes(item)) list.push(item);
        };
        add(goal.success_criteria, event.add_success_criteria);
        add(goal.constraints, event.add_constraints);
        add(goal.assumptions, event.add_assumptions);
        add(goal.decisions, event.add_decisions);
        break;
      }
      case 'question_raised':
        if (event.for_message && superseded.has(event.for_message)) break;
        if (!state.dialogue.questions.some((q) => q.id === event.id)) {
          state.dialogue.questions.push({
            id: event.id,
            text: event.text,
            blocking: event.blocking,
            status: 'open',
          });
        }
        break;
      case 'question_resolved': {
        if (event.for_message && superseded.has(event.for_message)) break;
        const question = state.dialogue.questions.find((q) => q.id === event.id);
        if (question) {
          question.status = 'resolved';
          if (event.answer) question.answer = event.answer;
        }
        break;
      }
      case 'message_edited': {
        const target = state.messages.find((m) => m.id === event.id);
        if (state.stalled_for === event.id) state.stalled_for = null;
        if (target) {
          target.text = event.text;
          target.edited = true;
        }
        break;
      }
      case 'message_feedback': {
        const target = state.messages.find((m) => m.id === event.id);
        if (target) {
          if (event.value) target.feedback = event.value;
          else delete target.feedback;
        }
        break;
      }
      case 'attachment_added':
        state.attachments.push({
          id: event.id,
          name: event.name,
          mime: event.mime,
          size: event.size,
          path: event.path,
          status: event.status,
          ...(event.excerpt ? { excerpt: event.excerpt } : {}),
          ts: event.ts,
        });
        break;
      case 'generation_stopped': {
        state.speaking = null;
        const lastHuman = [...state.messages]
          .reverse()
          .find((m) => m.kind === 'human' && !m.superseded);
        state.stalled_for = lastHuman?.id ?? null;
        break;
      }
      case 'room_renamed':
        state.title = event.title;
        break;
      case 'room_archived':
        state.archived = event.archived;
        break;
      case 'error':
        state.error = event.message;
        state.status = 'failed';
        state.speaking = null;
        break;
    }
  }
  Object.assign(state.dialogue, computeDialogueReadiness(state.dialogue));
  return state;
}

export function summarizeDiscussionRoom(state: DiscussionRoomState): DiscussionRoomSummary {
  return {
    id: state.id,
    title: state.title,
    goal: state.goal,
    status: state.status,
    phase: state.phase,
    round: state.round,
    consensus: state.consensus,
    participant_count: state.participants.length,
    message_count: state.messages.length,
    proposal_count: state.outcomes.proposals.length,
    work_item_count: Object.keys(state.outcomes.work_items).length,
    has_minutes: state.outcomes.minutes !== null,
    mode: state.config.mode,
    archived: state.archived,
    readiness: state.dialogue.readiness,
    last_message_preview: (() => {
      const last = [...state.messages].reverse().find((m) => !m.superseded);
      return last
        ? last.text
            .replace(/[*_`#>]+/gu, '')
            .replace(/\s+/gu, ' ')
            .trim()
            .slice(0, 120)
        : '';
    })(),
    scope: state.scope,
    created_at: state.created_at,
    updated_at: state.updated_at,
  };
}
