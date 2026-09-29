import type {
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

/** Pure projection of the event log into the state every surface renders. */
export function reduceDiscussionRoom(
  id: string,
  events: readonly DiscussionEvent[]
): DiscussionRoomState {
  const state = emptyState(id);
  for (const event of events) {
    state.last_seq = event.seq;
    state.updated_at = event.ts;
    switch (event.type) {
      case 'room_created':
        state.title = event.title;
        state.goal = event.goal;
        state.scope = event.scope;
        state.config = event.config;
        state.created_by = event.created_by;
        state.created_at = event.ts;
        break;
      case 'team_formed':
        state.participants = event.participants;
        state.staffing_gaps = event.gaps;
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
      case 'message':
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
          round: event.round,
        });
        state.stance_by_speaker[event.speaker] = event.stance;
        state.message_counts[event.speaker] = (state.message_counts[event.speaker] ?? 0) + 1;
        break;
      case 'human_message':
        state.messages.push({
          id: event.id,
          kind: 'human',
          speaker: event.actor,
          text: event.text,
          ts: event.ts,
          ...(event.target ? { mentions: [event.target] } : {}),
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
      case 'error':
        state.error = event.message;
        state.status = 'failed';
        state.speaking = null;
        break;
    }
  }
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
    scope: state.scope,
    created_at: state.created_at,
    updated_at: state.updated_at,
  };
}
