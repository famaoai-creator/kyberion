import { randomUUID } from 'node:crypto';
import {
  appendDiscussionEvent,
  readDiscussionRoom,
  sanitizeDiscussionId,
} from './discussion-store.js';
import { composeDiscussionTeam } from './discussion-team.js';
import {
  resolveDiscussionSpeaker,
  type DiscussionSpeaker,
  type SpeakIntent,
} from './discussion-speaker.js';
import type {
  DiscussionAgendaItem,
  DiscussionCommand,
  DiscussionParticipant,
  DiscussionRoomState,
  DiscussionStance,
} from './discussion-types.js';

const TERMINAL = new Set(['concluded', 'stopped', 'failed']);
const STANCE_WEIGHT: Record<DiscussionStance, number> = {
  support: 1,
  neutral: 0.55,
  question: 0.35,
  oppose: 0,
};

export interface DiscussionEngineOptions {
  speaker?: DiscussionSpeaker;
  /** Injected in tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type RunRegistry = Map<string, Promise<void>>;
const REGISTRY_KEY = '__kyberionDiscussionEngines';

function registry(): RunRegistry {
  const holder = globalThis as unknown as Record<string, RunRegistry | undefined>;
  return (holder[REGISTRY_KEY] ??= new Map());
}

export function isDiscussionRunning(roomId: string): boolean {
  return registry().has(roomId);
}

/**
 * Start (or keep) the single engine that owns a room. Idempotent: a second
 * call while the engine is alive returns the same run — one owner per room.
 */
export function ensureDiscussionRunning(
  roomId: string,
  options: DiscussionEngineOptions = {}
): Promise<void> {
  const id = sanitizeDiscussionId(roomId);
  const existing = registry().get(id);
  if (existing) return existing;
  const run = new DiscussionEngine(id, options)
    .run()
    .catch((error: unknown) => {
      appendDiscussionEvent(id, {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      registry().delete(id);
    });
  registry().set(id, run);
  return run;
}

function defaultAgenda(state: DiscussionRoomState): DiscussionAgendaItem[] {
  const ja = state.config.locale === 'ja';
  return [
    {
      id: 'ag-1',
      title: ja ? '目的と前提条件の整理' : 'Clarify the goal and preconditions',
      status: 'pending',
    },
    {
      id: 'ag-2',
      title: ja ? '選択肢・懸念・リスクの検討' : 'Weigh options, concerns and risks',
      status: 'pending',
    },
    {
      id: 'ag-3',
      title: ja ? '合意形成と次のアクション' : 'Converge on a decision and next actions',
      status: 'pending',
    },
  ];
}

export function computeConsensus(state: DiscussionRoomState): number {
  const stances = state.participants
    .filter((p) => p.role !== 'facilitator' && p.role !== 'scribe')
    .map((p) => state.stance_by_speaker[p.id])
    .filter((s): s is DiscussionStance => Boolean(s));
  if (stances.length === 0) return 0;
  const raw = stances.reduce((sum, s) => sum + STANCE_WEIGHT[s], 0) / stances.length;
  return Number(Math.max(0, Math.min(1, raw)).toFixed(2));
}

class DiscussionEngine {
  private readonly speaker: DiscussionSpeaker;
  private readonly sleep: (ms: number) => Promise<void>;
  private forceConclude = false;
  private forcedNext: string | null = null;

  constructor(
    private readonly roomId: string,
    options: DiscussionEngineOptions
  ) {
    const room = this.room();
    this.speaker = options.speaker ?? resolveDiscussionSpeaker(room.config.speaker);
    this.sleep = options.sleep ?? realSleep;
  }

  private room(): DiscussionRoomState {
    const room = readDiscussionRoom(this.roomId);
    if (!room) throw new Error(`Discussion room not found: ${this.roomId}`);
    return room;
  }

  private stopped(): boolean {
    return TERMINAL.has(this.room().status);
  }

  async run(): Promise<void> {
    let room = this.room();
    if (TERMINAL.has(room.status)) return;

    if (room.participants.length === 0) {
      const plan = composeDiscussionTeam(room.goal);
      appendDiscussionEvent(this.roomId, {
        type: 'team_formed',
        participants: plan.participants,
        gaps: plan.gaps,
      });
      room = this.room();
      appendDiscussionEvent(this.roomId, { type: 'agenda_set', agenda: defaultAgenda(room) });
    }
    room = this.room();
    const facilitator = this.facilitator(room);
    if (!facilitator) {
      appendDiscussionEvent(this.roomId, {
        type: 'error',
        message: 'No facilitator could be staffed for this discussion.',
      });
      return;
    }

    if (room.messages.length === 0 && room.phase === 'forming') {
      appendDiscussionEvent(this.roomId, {
        type: 'phase_changed',
        phase: 'framing',
        round: 1,
        note: `speaker=${this.speaker.mode}`,
      });
      await this.turn(facilitator, 'frame', 'ag-1');
    }

    while (!this.stopped()) {
      room = this.room();
      if (room.phase === 'concluded') return;
      if (room.round > room.config.max_rounds || room.messages.length >= room.config.max_messages) {
        break;
      }
      const roundNumber = Math.max(1, room.round);
      const agendaId = this.agendaForRound(room, roundNumber);
      if (room.phase !== 'exploring' || room.round !== roundNumber) {
        appendDiscussionEvent(this.roomId, {
          type: 'phase_changed',
          phase: roundNumber >= room.config.max_rounds ? 'converging' : 'exploring',
          round: roundNumber,
        });
      }
      for (const participant of this.speakingOrder(this.room())) {
        if (!(await this.checkpoint())) return;
        if (this.forceConclude) break;
        await this.turn(participant, 'contribute', agendaId);
      }
      if (!(await this.checkpoint())) return;
      await this.summarizeRound(facilitator, roundNumber);
      const after = this.room();
      this.closeOpenVotes(after);
      if (this.forceConclude) break;
      if (
        after.consensus >= after.config.consensus_threshold &&
        roundNumber >= 2 &&
        after.open_issues.length === 0
      ) {
        break;
      }
      appendDiscussionEvent(this.roomId, {
        type: 'phase_changed',
        phase: 'exploring',
        round: roundNumber + 1,
      });
    }
    if (this.stopped()) return;
    await this.conclude(facilitator);
  }

  private facilitator(room: DiscussionRoomState): DiscussionParticipant | undefined {
    return room.participants.find((p) => p.role === 'facilitator');
  }

  private speakingOrder(room: DiscussionRoomState): DiscussionParticipant[] {
    const rest = room.participants.filter((p) => p.role !== 'facilitator' && p.role !== 'scribe');
    const scribe = room.participants.filter((p) => p.role === 'scribe');
    // Let the critic answer a substantive proposal rather than open the round.
    const critic = rest.filter((p) => p.role === 'devils_advocate');
    const others = rest.filter((p) => p.role !== 'devils_advocate');
    return [...others.slice(0, 2), ...critic, ...others.slice(2), ...scribe];
  }

  private agendaForRound(room: DiscussionRoomState, round: number): string | undefined {
    const items = room.agenda;
    if (items.length === 0) return undefined;
    const pending =
      items.find((i) => i.status === 'active') ?? items.find((i) => i.status === 'pending');
    if (round <= 1) return items[0]?.id;
    const index = Math.min(
      items.length - 1,
      Math.floor(((round - 1) * items.length) / room.config.max_rounds)
    );
    return items[index]?.id ?? pending?.id;
  }

  private async turn(
    participant: DiscussionParticipant,
    intent: SpeakIntent,
    agendaId: string | undefined,
    humanPrompt?: string,
    replyTo?: string
  ): Promise<void> {
    appendDiscussionEvent(this.roomId, {
      type: 'turn_started',
      speaker: participant.id,
      ...(agendaId ? { agenda_id: agendaId } : {}),
    });
    const room = this.room();
    const [result] = await Promise.all([
      this.speaker.speak({
        room,
        participant,
        intent,
        agenda: room.agenda.find((i) => i.id === agendaId),
        humanPrompt,
      }),
      this.sleep(room.config.turn_delay_ms),
    ]);
    const latest = this.room();
    if (TERMINAL.has(latest.status)) return;
    const lastAgent = [...latest.messages].reverse().find((m) => m.kind === 'agent');
    appendDiscussionEvent(this.roomId, {
      type: 'message',
      id: `msg-${randomUUID().slice(0, 10)}`,
      speaker: participant.id,
      text: result.text,
      performative: result.performative,
      stance: result.stance,
      round: Math.max(1, latest.round),
      ...(replyTo
        ? { reply_to: replyTo }
        : lastAgent && lastAgent.speaker !== participant.id
          ? { reply_to: lastAgent.id }
          : {}),
      ...(result.mentions?.length ? { mentions: result.mentions } : {}),
      ...(agendaId ? { agenda_id: agendaId } : {}),
    });
  }

  private async summarizeRound(facilitator: DiscussionParticipant, round: number): Promise<void> {
    const room = this.room();
    const summary = await this.speaker.summarize({
      room,
      participant: facilitator,
      intent: 'summarize',
    });
    appendDiscussionEvent(this.roomId, {
      type: 'facilitator_summary',
      round,
      summary: summary.summary,
      consensus: computeConsensus(this.room()),
      open_issues: summary.open_issues,
      agreements: summary.agreements,
    });
  }

  private async conclude(facilitator: DiscussionParticipant): Promise<void> {
    const room = this.room();
    appendDiscussionEvent(this.roomId, {
      type: 'phase_changed',
      phase: 'converging',
      round: room.round,
    });
    const draft = await this.speaker.conclude({
      room,
      participant: facilitator,
      intent: 'conclude',
    });
    appendDiscussionEvent(this.roomId, {
      type: 'decision',
      summary: draft.summary,
      agreements: draft.agreements,
      dissent: draft.dissent,
      next_steps: draft.next_steps,
      consensus: computeConsensus(this.room()),
      concluded_by: facilitator.id,
    });
  }

  private closeOpenVotes(room: DiscussionRoomState): void {
    for (const vote of room.votes.filter((v) => v.status === 'open')) {
      this.finishVote(vote.id);
    }
  }

  private finishVote(voteId: string): void {
    const vote = this.room().votes.find((v) => v.id === voteId);
    if (!vote || vote.status !== 'open') return;
    const sorted = Object.entries(vote.tally).sort((a, b) => b[1] - a[1]);
    const winner =
      sorted[0] && sorted[0][1] > 0 && sorted[0][1] !== sorted[1]?.[1] ? sorted[0][0] : undefined;
    appendDiscussionEvent(this.roomId, {
      type: 'vote_closed',
      vote_id: voteId,
      tally: vote.tally,
      ...(winner ? { winner } : {}),
    });
  }

  /**
   * Apply human commands between turns. Returns false when the room ended.
   * While paused / awaiting a human the engine parks here and keeps polling —
   * commands (including `resume` and `stop`) are the only way out.
   */
  private async checkpoint(): Promise<boolean> {
    for (;;) {
      const room = this.room();
      if (TERMINAL.has(room.status)) return false;
      for (const pending of room.pending_commands) {
        await this.applyCommand(pending.id, pending.actor, pending.command);
      }
      const after = this.room();
      if (TERMINAL.has(after.status)) return false;
      if (after.status === 'paused' || after.status === 'awaiting_human') {
        await this.sleep(250);
        continue;
      }
      if (this.forcedNext) {
        const target = after.participants.find((p) => p.id === this.forcedNext);
        this.forcedNext = null;
        if (target) await this.turn(target, 'contribute', undefined);
      }
      return true;
    }
  }

  private ack(commandId: string, outcome: 'applied' | 'ignored', note?: string): void {
    appendDiscussionEvent(this.roomId, {
      type: 'command_ack',
      command_id: commandId,
      outcome,
      ...(note ? { note } : {}),
    });
  }

  private async applyCommand(
    commandId: string,
    actor: string,
    command: DiscussionCommand
  ): Promise<void> {
    const room = this.room();
    const text = command.text?.trim().slice(0, 1000);
    switch (command.kind) {
      case 'pause':
        appendDiscussionEvent(this.roomId, {
          type: 'status_changed',
          status: 'paused',
          reason: `paused by ${actor}`,
        });
        return this.ack(commandId, 'applied');
      case 'resume':
        appendDiscussionEvent(this.roomId, { type: 'status_changed', status: 'running' });
        return this.ack(commandId, 'applied');
      case 'stop':
        appendDiscussionEvent(this.roomId, {
          type: 'status_changed',
          status: 'stopped',
          reason: `stopped by ${actor}`,
        });
        return this.ack(commandId, 'applied');
      case 'conclude':
        this.forceConclude = true;
        if (room.status === 'paused') {
          appendDiscussionEvent(this.roomId, { type: 'status_changed', status: 'running' });
        }
        return this.ack(commandId, 'applied', 'concluding after current turn');
      case 'set_speaker': {
        if (!command.target || !room.participants.some((p) => p.id === command.target)) {
          return this.ack(commandId, 'ignored', 'unknown participant');
        }
        this.forcedNext = command.target;
        return this.ack(commandId, 'applied');
      }
      case 'inject':
      case 'ask': {
        if (!text) return this.ack(commandId, 'ignored', 'empty message');
        const target =
          room.participants.find((p) => p.id === command.target) ?? this.facilitator(room);
        const humanId = `hum-${randomUUID().slice(0, 10)}`;
        appendDiscussionEvent(this.roomId, {
          type: 'human_message',
          id: humanId,
          actor,
          text,
          ...(command.target ? { target: command.target } : {}),
          round: Math.max(1, room.round),
        });
        this.ack(commandId, 'applied');
        if (target) await this.turn(target, 'respond_human', undefined, text, humanId);
        return;
      }
      case 'redirect': {
        if (!text) return this.ack(commandId, 'ignored', 'empty redirect');
        const humanId = `hum-${randomUUID().slice(0, 10)}`;
        const agenda: DiscussionAgendaItem[] = [
          { id: `ag-r${room.last_seq}`, title: text.slice(0, 120), status: 'active' },
          ...room.agenda.map((item) =>
            item.status === 'active' ? { ...item, status: 'pending' as const } : item
          ),
        ];
        appendDiscussionEvent(this.roomId, {
          type: 'human_message',
          id: humanId,
          actor,
          text,
          round: Math.max(1, room.round),
        });
        appendDiscussionEvent(this.roomId, { type: 'agenda_set', agenda });
        this.ack(commandId, 'applied', 'agenda redirected');
        const facilitator = this.facilitator(room);
        if (facilitator) await this.turn(facilitator, 'respond_human', agenda[0].id, text, humanId);
        return;
      }
      case 'open_vote': {
        if (!text) return this.ack(commandId, 'ignored', 'empty question');
        const ja = room.config.locale === 'ja';
        const options =
          command.options && command.options.length >= 2
            ? command.options.slice(0, 5)
            : ja
              ? ['賛成', '反対', '保留']
              : ['Approve', 'Reject', 'Abstain'];
        const voteId = `vote-${randomUUID().slice(0, 8)}`;
        const eligible = room.participants.filter((p) => p.role !== 'scribe').map((p) => p.id);
        appendDiscussionEvent(this.roomId, {
          type: 'vote_opened',
          id: voteId,
          question: text,
          options,
          eligible: [...eligible, 'human'],
          opened_by: actor,
        });
        for (const participant of room.participants.filter((p) => eligible.includes(p.id))) {
          const stance = room.stance_by_speaker[participant.id] ?? 'neutral';
          const choice =
            stance === 'support'
              ? options[0]
              : stance === 'oppose'
                ? options[1]
                : options[options.length - 1];
          appendDiscussionEvent(this.roomId, {
            type: 'vote_cast',
            vote_id: voteId,
            voter: participant.id,
            choice,
            kind: 'agent',
          });
        }
        return this.ack(commandId, 'applied');
      }
      case 'cast_vote': {
        const vote = [...room.votes].reverse().find((v) => v.status === 'open');
        if (!vote || !command.choice || !vote.options.includes(command.choice)) {
          return this.ack(commandId, 'ignored', 'no open vote or invalid choice');
        }
        appendDiscussionEvent(this.roomId, {
          type: 'vote_cast',
          vote_id: vote.id,
          voter: 'human',
          choice: command.choice,
          kind: 'human',
        });
        this.finishVote(vote.id);
        return this.ack(commandId, 'applied');
      }
    }
  }
}
