/**
 * Discussion Room — a facilitated, multi-agent conversation toward a goal.
 *
 * The room is event-sourced: `events.jsonl` is the only source of truth and
 * `reduceDiscussionRoom` derives the state every surface renders. Humans steer
 * the room by appending `command` events; the facilitator engine acknowledges
 * them between turns. Visibility is decided by the viewer scope at the surface
 * (tenant / organization / project), never by client-supplied parameters.
 */

export type DiscussionRoomStatus =
  'forming' | 'running' | 'paused' | 'awaiting_human' | 'concluded' | 'stopped' | 'failed';

export type DiscussionPhase = 'forming' | 'framing' | 'exploring' | 'converging' | 'concluded';

export type DiscussionStance = 'support' | 'oppose' | 'neutral' | 'question';

export type DiscussionPerformative = 'inform' | 'propose' | 'challenge' | 'agree' | 'summarize';

export interface DiscussionScope {
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
  mission_id?: string;
  /** Data tier the room's outputs inherit (from the linked mission); defaults to confidential. */
  tier?: 'public' | 'confidential' | 'personal';
}

export interface DiscussionParticipant {
  id: string;
  /** Organization agent (profile id) that fills this seat. */
  agent_id: string;
  /** Team role the agent was staffed into (facilitator, researcher, …). */
  role: string;
  name: string;
  /** Why the agent was selected — shown in the team-formation view. */
  rationale: string;
  /** 0..1 fit score from capability match + preferred-agent hints. */
  fit: number;
  capabilities: string[];
}

export interface DiscussionAgendaItem {
  id: string;
  title: string;
  status: 'pending' | 'active' | 'done';
}

export type DiscussionCommandKind =
  | 'pause'
  | 'resume'
  | 'inject'
  | 'redirect'
  | 'ask'
  | 'open_vote'
  | 'cast_vote'
  | 'conclude'
  | 'stop'
  | 'set_speaker'
  // Dialogue mode (a human talking with the facilitator):
  | 'finalize'
  | 'consult'
  | 'regenerate'
  | 'edit_message'
  | 'stop_generation'
  | 'feedback'
  | 'summarize';

export interface DiscussionCommand {
  kind: DiscussionCommandKind;
  text?: string;
  /** Target participant (ask / set_speaker / cast_vote as agent). */
  target?: string;
  /** Vote options (open_vote) or the chosen option (cast_vote). */
  options?: string[];
  choice?: string;
  /** Uploaded attachment ids that ride along with an inject (dialogue mode). */
  attachments?: string[];
}

export interface DiscussionConfig {
  max_rounds: number;
  max_messages: number;
  consensus_threshold: number;
  /** Delay between turns so the surface can animate (ms). 0 in tests. */
  turn_delay_ms: number;
  locale: 'ja' | 'en';
  /** `auto` uses the reasoning backend when one is registered, else scripted. */
  speaker: 'auto' | 'scripted' | 'reasoning';
  /**
   * `panel`: agents discuss among themselves, the human steers.
   * `dialogue`: the human converses with the facilitator, who asks, records
   * the goal as it takes shape and pulls in the team on request.
   */
  mode: 'panel' | 'dialogue';
}

export const DEFAULT_DISCUSSION_CONFIG: DiscussionConfig = {
  max_rounds: 4,
  max_messages: 40,
  consensus_threshold: 0.8,
  turn_delay_ms: 1800,
  locale: 'ja',
  speaker: 'auto',
  mode: 'panel',
};

type EventBase = { seq: number; ts: string };

export type DiscussionEvent = EventBase &
  (
    | {
        type: 'room_created';
        goal: string;
        title: string;
        scope: DiscussionScope;
        config: DiscussionConfig;
        created_by: string;
      }
    | {
        type: 'team_formed';
        participants: DiscussionParticipant[];
        gaps: string[];
        /** Who chose the discretionary seats: fixed rules or the reasoning backend. */
        roster_source?: 'rules' | 'llm';
      }
    | { type: 'agenda_set'; agenda: DiscussionAgendaItem[] }
    | { type: 'phase_changed'; phase: DiscussionPhase; round: number; note?: string }
    | { type: 'turn_started'; speaker: string; agenda_id?: string }
    | {
        type: 'message';
        id: string;
        speaker: string;
        text: string;
        performative: DiscussionPerformative;
        stance: DiscussionStance;
        reply_to?: string;
        mentions?: string[];
        round: number;
        agenda_id?: string;
        /** Quick replies the speaker offers the human (dialogue mode). */
        suggestions?: string[];
        /** Pulled in by the facilitator or by an @mention rather than taking a scheduled turn. */
        consulted?: boolean;
      }
    | {
        type: 'human_message';
        id: string;
        actor: string;
        text: string;
        target?: string;
        round: number;
        attachments?: string[];
      }
    | {
        type: 'facilitator_summary';
        round: number;
        summary: string;
        consensus: number;
        open_issues: string[];
        agreements: string[];
      }
    | { type: 'command'; id: string; actor: string; command: DiscussionCommand }
    | { type: 'command_ack'; command_id: string; outcome: 'applied' | 'ignored'; note?: string }
    | { type: 'status_changed'; status: DiscussionRoomStatus; reason?: string }
    | {
        type: 'vote_opened';
        id: string;
        question: string;
        options: string[];
        eligible: string[];
        opened_by: string;
      }
    | { type: 'vote_cast'; vote_id: string; voter: string; choice: string; kind: 'agent' | 'human' }
    | { type: 'vote_closed'; vote_id: string; tally: Record<string, number>; winner?: string }
    | {
        type: 'decision';
        summary: string;
        agreements: string[];
        dissent: string[];
        next_steps: string[];
        consensus: number;
        concluded_by: string;
      }
    | { type: 'outcomes_proposed'; proposals: DiscussionWorkProposal[] }
    | {
        type: 'minutes_published';
        artifact_id: string;
        path: string;
        kind: string;
      }
    | { type: 'brief_published'; artifact_id: string; path: string }
    | {
        type: 'workitems_created';
        actor: string;
        links: Array<{ proposal_id: string; item_id: string }>;
      }
    | {
        type: 'proposals_edited';
        actor: string;
        edits: Array<{
          id: string;
          title?: string;
          priority?: DiscussionWorkProposal['priority'];
          owner_role?: string | null;
          included?: boolean;
        }>;
      }
    | {
        type: 'review_recorded';
        actor: string;
        verdict: DiscussionReviewVerdict;
        note?: string;
      }
    | { type: 'reopened'; actor: string; note: string; extra_rounds: number }
    | { type: 'mission_requested'; approval_id: string; approval_channel: string; actor: string }
    | { type: 'mission_started'; mission_id: string; actor: string }
    | {
        type: 'goal_patched';
        /** The facilitator reply this patch came with; superseding that reply rolls the patch back. */
        for_message?: string;
        objective?: string;
        add_success_criteria?: string[];
        add_constraints?: string[];
        add_assumptions?: string[];
        add_decisions?: string[];
      }
    | {
        type: 'question_raised';
        for_message?: string;
        id: string;
        text: string;
        blocking: boolean;
      }
    | { type: 'question_resolved'; for_message?: string; id: string; answer?: string }
    | { type: 'message_edited'; id: string; text: string; actor: string }
    | { type: 'message_superseded'; ids: string[]; reason: 'regenerate' | 'edit' }
    | {
        type: 'message_feedback';
        id: string;
        value: 'up' | 'down' | null;
        actor: string;
      }
    | {
        type: 'attachment_added';
        id: string;
        name: string;
        mime: string;
        size: number;
        path: string;
        status: 'read' | 'stored';
        excerpt?: string;
        actor: string;
      }
    | { type: 'generation_stopped'; speaker: string }
    | { type: 'room_renamed'; title: string; actor: string }
    | { type: 'room_archived'; archived: boolean; actor: string }
    | { type: 'error'; message: string }
  );

export type DiscussionReviewVerdict = 'accept' | 'request-changes' | 'reject';

/** A follow-up the decision implies, offered to a human before it becomes a WorkItem. */
export interface DiscussionWorkProposal {
  id: string;
  title: string;
  description: string;
  priority: 'low' | 'normal' | 'high';
  /** Team role best placed to own it (informational; assignment stays human). */
  owner_role?: string;
  /** Reviewer can drop a proposal before accepting; defaults to included. */
  included?: boolean;
}

export interface DiscussionOutcomes {
  proposals: DiscussionWorkProposal[];
  minutes: { artifact_id: string; path: string; kind: string } | null;
  /** The interactive decision brief (HTML deliverable). */
  brief: { artifact_id: string; path: string } | null;
  /** proposal id → created WorkItem id */
  work_items: Record<string, string>;
  /** The human review of the decision brief; null until someone decides. */
  review: { verdict: DiscussionReviewVerdict; note?: string; actor: string; ts: string } | null;
  /** The mission-start approval request raised by an accepted decision. */
  mission: {
    approval_id: string;
    approval_channel: string;
    /** Live status of the approval, filled in when the room is read. */
    approval_status?: 'pending' | 'approved' | 'rejected' | 'unknown';
    mission_id?: string;
  } | null;
}

export type DiscussionEventType = DiscussionEvent['type'];

/** Distributive omit so callers can pass event bodies without seq/ts. */
export type DiscussionEventBody = DiscussionEvent extends infer E
  ? E extends DiscussionEvent
    ? Omit<E, 'seq' | 'ts'>
    : never
  : never;

export interface DiscussionMessageView {
  id: string;
  kind: 'agent' | 'human' | 'system';
  speaker: string;
  text: string;
  ts: string;
  performative?: DiscussionPerformative;
  stance?: DiscussionStance;
  reply_to?: string;
  mentions?: string[];
  round: number;
  suggestions?: string[];
  consulted?: boolean;
  attachments?: string[];
  edited?: boolean;
  /** Replaced by a regenerate / edit; kept so the history stays honest. */
  superseded?: boolean;
  feedback?: 'up' | 'down';
}

export interface DiscussionVoteView {
  id: string;
  question: string;
  options: string[];
  eligible: string[];
  ballots: Record<string, { choice: string; kind: 'agent' | 'human' }>;
  status: 'open' | 'closed';
  tally: Record<string, number>;
  winner?: string;
}

export interface DialogueQuestion {
  id: string;
  text: string;
  blocking: boolean;
  status: 'open' | 'resolved';
  answer?: string;
}

/** What the conversation has established so far — the goal as it takes shape. */
export interface DialogueGoalState {
  objective: string;
  success_criteria: string[];
  constraints: string[];
  assumptions: string[];
  decisions: string[];
  questions: DialogueQuestion[];
  /** 0..1: how much of what is needed to draft a decision brief is in place. */
  readiness: number;
  /** Enough is settled to draft the brief (readiness high and nothing blocking is open). */
  ready: boolean;
}

export interface DiscussionAttachmentView {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
  status: 'read' | 'stored';
  excerpt?: string;
  ts: string;
}

export interface DiscussionRoomState {
  id: string;
  title: string;
  goal: string;
  scope: DiscussionScope;
  config: DiscussionConfig;
  created_by: string;
  created_at: string;
  updated_at: string;
  status: DiscussionRoomStatus;
  status_reason?: string;
  phase: DiscussionPhase;
  round: number;
  participants: DiscussionParticipant[];
  staffing_gaps: string[];
  roster_source: 'rules' | 'llm';
  agenda: DiscussionAgendaItem[];
  messages: DiscussionMessageView[];
  /** Participant currently composing (turn_started with no message yet). */
  speaking: string | null;
  consensus: number;
  consensus_history: Array<{ round: number; value: number }>;
  open_issues: string[];
  agreements: string[];
  summaries: Array<{ round: number; summary: string; ts: string }>;
  stance_by_speaker: Record<string, DiscussionStance>;
  message_counts: Record<string, number>;
  votes: DiscussionVoteView[];
  decision: Extract<DiscussionEvent, { type: 'decision' }> | null;
  outcomes: DiscussionOutcomes;
  dialogue: DialogueGoalState;
  attachments: DiscussionAttachmentView[];
  archived: boolean;
  /** A human message whose reply the person stopped; it waits for an explicit regenerate. */
  stalled_for: string | null;
  /** Commands not yet acknowledged by the engine. */
  pending_commands: Array<{ id: string; actor: string; command: DiscussionCommand; ts: string }>;
  last_seq: number;
  error?: string;
  /** Ephemeral partial reply being generated; never persisted, added when the room is served. */
  live?: { speaker: string; text: string } | null;
}

export interface DiscussionRoomSummary {
  id: string;
  title: string;
  goal: string;
  status: DiscussionRoomStatus;
  phase: DiscussionPhase;
  round: number;
  consensus: number;
  participant_count: number;
  message_count: number;
  proposal_count: number;
  work_item_count: number;
  has_minutes: boolean;
  mode: 'panel' | 'dialogue';
  archived: boolean;
  readiness: number;
  last_message_preview: string;
  scope: DiscussionScope;
  created_at: string;
  updated_at: string;
}
