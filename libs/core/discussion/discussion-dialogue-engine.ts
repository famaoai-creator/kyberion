import { randomUUID } from 'node:crypto';
import { loadDiscussionCopy } from './discussion-copy.js';
import {
  beginLiveReply,
  endLiveReply,
  generationStopRequested,
  updateLiveReply,
} from './discussion-live.js';
import { publishDiscussionOutcomes } from './discussion-outcomes.js';
import {
  type DialogueAttachmentContext,
  type DialogueReply,
  type DiscussionSpeaker,
} from './discussion-speaker.js';
import { appendDiscussionEvent, readDiscussionRoom } from './discussion-store.js';
import type {
  DiscussionCommand,
  DiscussionMessageView,
  DiscussionParticipant,
  DiscussionRoomState,
} from './discussion-types.js';

const TERMINAL = new Set(['concluded', 'stopped', 'failed']);
/** A dialogue that nobody has touched for this long lets its engine go; the next command restarts it. */
const DEFAULT_IDLE_MS = 30 * 60 * 1000;

export interface DialogueRunOptions {
  speaker: DiscussionSpeaker;
  sleep: (ms: number) => Promise<void>;
  /** Tests: return as soon as nothing is left to do instead of waiting for the human. */
  exitWhenIdle?: boolean;
  idleMs?: number;
}

function visible(room: DiscussionRoomState): DiscussionMessageView[] {
  return room.messages.filter((m) => !m.superseded);
}

/**
 * The engine of a human-first conversation. The human talks; the facilitator
 * answers each message, asks the next question, and records the goal as it
 * takes shape. The engine idles between messages and is the only writer of the
 * facilitator's side of the log.
 */
export class DialogueRunner {
  constructor(
    private readonly roomId: string,
    private readonly options: DialogueRunOptions
  ) {}

  private room(): DiscussionRoomState {
    const room = readDiscussionRoom(this.roomId);
    if (!room) throw new Error(`Discussion room not found: ${this.roomId}`);
    return room;
  }

  private facilitator(room: DiscussionRoomState): DiscussionParticipant {
    const facilitator = room.participants.find((p) => p.role === 'facilitator');
    if (!facilitator) throw new Error('No facilitator could be staffed for this dialogue.');
    return facilitator;
  }

  async run(): Promise<void> {
    let room = this.room();
    if (TERMINAL.has(room.status)) return;
    const facilitator = this.facilitator(room);

    if (room.messages.length === 0) {
      appendDiscussionEvent(this.roomId, { type: 'phase_changed', phase: 'framing', round: 1 });
      const opening = await this.options.speaker.dialogueOpen?.(room, facilitator);
      if (opening) this.commit(opening, undefined);
    }

    const idleMs = this.options.idleMs ?? DEFAULT_IDLE_MS;
    let idleSince = Date.now();
    for (;;) {
      room = this.room();
      if (TERMINAL.has(room.status)) return;
      if (room.pending_commands.length > 0) {
        for (const pending of room.pending_commands) {
          await this.apply(pending.id, pending.actor, pending.command);
          if (TERMINAL.has(this.room().status)) return;
        }
        idleSince = Date.now();
        continue;
      }
      if (room.status === 'paused') {
        await this.options.sleep(250);
        continue;
      }
      const unanswered = this.unansweredHuman(room);
      if (unanswered && unanswered.id !== room.stalled_for) {
        await this.reply(unanswered.id, false);
        idleSince = Date.now();
        continue;
      }
      if (this.options.exitWhenIdle) return;
      if (Date.now() - idleSince > idleMs) return;
      await this.options.sleep(200);
    }
  }

  /** The last visible message is a human one addressed to the facilitator and nothing has answered it. */
  private unansweredHuman(room: DiscussionRoomState): DiscussionMessageView | null {
    const last = visible(room).at(-1);
    return last && last.kind === 'human' && !last.mentions?.length ? last : null;
  }

  private ack(commandId: string, outcome: 'applied' | 'ignored', note?: string): void {
    appendDiscussionEvent(this.roomId, {
      type: 'command_ack',
      command_id: commandId,
      outcome,
      ...(note ? { note } : {}),
    });
  }

  private humanMessage(
    actor: string,
    text: string,
    extra: { target?: string; attachments?: string[] }
  ) {
    const id = `hum-${randomUUID().slice(0, 10)}`;
    appendDiscussionEvent(this.roomId, {
      type: 'human_message',
      id,
      actor,
      text,
      ...(extra.target ? { target: extra.target } : {}),
      ...(extra.attachments?.length ? { attachments: extra.attachments } : {}),
      round: 1,
    });
    return id;
  }

  private async apply(commandId: string, actor: string, command: DiscussionCommand): Promise<void> {
    const room = this.room();
    const text = command.text?.trim().slice(0, 4000);
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
      case 'finalize':
      case 'conclude':
        this.ack(commandId, 'applied');
        await this.conclude();
        return;
      case 'summarize':
        this.ack(commandId, 'applied');
        this.postSummary(room);
        return;
      case 'inject':
      case 'redirect': {
        if (!text && !command.attachments?.length)
          return this.ack(commandId, 'ignored', 'empty message');
        const message = text || '';
        const mention = this.mentionedRole(room, message);
        if (mention) {
          this.humanMessage(actor, message, {
            target: mention.id,
            attachments: command.attachments,
          });
          this.ack(commandId, 'applied');
          await this.consult(mention, message);
          return;
        }
        const humanId = this.humanMessage(actor, message, { attachments: command.attachments });
        this.ack(commandId, 'applied');
        // Answer each message in turn, so several sent in quick succession are all heard.
        await this.reply(humanId, false);
        return;
      }
      case 'ask':
      case 'consult': {
        const target = room.participants.find(
          (p) => p.id === command.target || p.role === command.target
        );
        if (!target || !text)
          return this.ack(commandId, 'ignored', 'unknown teammate or empty question');
        this.humanMessage(actor, text, { target: target.id });
        this.ack(commandId, 'applied');
        await this.consult(target, text);
        return;
      }
      case 'regenerate': {
        const human = this.regenerationTarget(room, command.target);
        if (!human) return this.ack(commandId, 'ignored', 'nothing to regenerate');
        this.ack(commandId, 'applied');
        await this.reply(human.id, true);
        return;
      }
      case 'edit_message': {
        const target = visible(room).find((m) => m.id === command.target && m.kind === 'human');
        if (!target || !text)
          return this.ack(commandId, 'ignored', 'only your own messages can be edited');
        appendDiscussionEvent(this.roomId, { type: 'message_edited', id: target.id, text, actor });
        const later = visible(room)
          .slice(visible(room).findIndex((m) => m.id === target.id) + 1)
          .map((m) => m.id);
        if (later.length) {
          appendDiscussionEvent(this.roomId, {
            type: 'message_superseded',
            ids: later,
            reason: 'edit',
          });
        }
        return this.ack(commandId, 'applied');
      }
      default:
        return this.ack(commandId, 'ignored', 'not available in a dialogue');
    }
  }

  private mentionedRole(
    room: DiscussionRoomState,
    text: string
  ): DiscussionParticipant | undefined {
    const match = text.match(/@([a-z_]+)/u);
    if (!match) return undefined;
    return room.participants.find((p) => p.role === match[1] && p.role !== 'facilitator');
  }

  private regenerationTarget(
    room: DiscussionRoomState,
    targetId?: string
  ): DiscussionMessageView | null {
    const messages = visible(room);
    const index = targetId ? messages.findIndex((m) => m.id === targetId) : messages.length - 1;
    if (index < 0) return null;
    const anchor = messages[index];
    let humanIndex = anchor.kind === 'human' ? index : -1;
    if (humanIndex < 0) {
      for (let i = index; i >= 0; i--) {
        if (messages[i].kind === 'human' && !messages[i].mentions?.length) {
          humanIndex = i;
          break;
        }
      }
    }
    if (humanIndex < 0) return null;
    // Replace everything the facilitator produced after that message.
    const replaced = messages
      .slice(humanIndex + 1)
      .filter((m) => m.kind === 'agent')
      .map((m) => m.id);
    if (replaced.length) {
      appendDiscussionEvent(this.roomId, {
        type: 'message_superseded',
        ids: replaced,
        reason: 'regenerate',
      });
    }
    return messages[humanIndex];
  }

  private attachmentContext(
    room: DiscussionRoomState,
    message: DiscussionMessageView
  ): DialogueAttachmentContext[] {
    return (message.attachments ?? []).flatMap((id) => {
      const attachment = room.attachments.find((a) => a.id === id);
      return attachment
        ? [
            {
              name: attachment.name,
              status: attachment.status,
              ...(attachment.excerpt ? { excerpt: attachment.excerpt } : {}),
            },
          ]
        : [];
    });
  }

  private async reply(humanId: string, retry: boolean): Promise<void> {
    const room = this.room();
    const facilitator = this.facilitator(room);
    const human = room.messages.find((m) => m.id === humanId);
    if (!human || !this.options.speaker.dialogueTurn) return;
    appendDiscussionEvent(this.roomId, { type: 'turn_started', speaker: facilitator.id });
    beginLiveReply(this.roomId, facilitator.id);
    let reply: DialogueReply;
    try {
      reply = await this.options.speaker.dialogueTurn(
        {
          room,
          facilitator,
          human: {
            id: human.id,
            text: human.text,
            attachments: this.attachmentContext(room, human),
          },
          retry,
        },
        {
          onText: (text) => updateLiveReply(this.roomId, text),
          shouldStop: () => generationStopRequested(this.roomId),
          delay: this.options.sleep,
        }
      );
    } catch (error) {
      endLiveReply(this.roomId);
      throw error;
    }
    const stoppedByUser = generationStopRequested(this.roomId);
    endLiveReply(this.roomId);
    if (stoppedByUser) {
      appendDiscussionEvent(this.roomId, { type: 'generation_stopped', speaker: facilitator.id });
      return;
    }
    this.commit(reply, humanId);
    for (const role of reply.consult) {
      const teammate = this.room().participants.find((p) => p.role === role);
      if (teammate) await this.consult(teammate, human.text);
    }
  }

  /** Persist a finished reply and everything it changed about the goal. */
  private commit(reply: DialogueReply, replyTo: string | undefined): void {
    const room = this.room();
    const facilitator = this.facilitator(room);
    const messageId = `msg-${randomUUID().slice(0, 10)}`;
    appendDiscussionEvent(this.roomId, {
      type: 'message',
      id: messageId,
      speaker: facilitator.id,
      text: reply.text,
      performative: 'inform',
      stance: 'neutral',
      round: 1,
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(reply.suggestions.length ? { suggestions: reply.suggestions } : {}),
    });
    const patch = reply.goal_patch;
    const hasPatch =
      patch.objective ||
      patch.add_success_criteria?.length ||
      patch.add_constraints?.length ||
      patch.add_assumptions?.length ||
      patch.add_decisions?.length;
    if (hasPatch) {
      appendDiscussionEvent(this.roomId, {
        type: 'goal_patched',
        for_message: messageId,
        ...patch,
      });
    }
    for (const question of reply.new_questions) {
      appendDiscussionEvent(this.roomId, {
        type: 'question_raised',
        for_message: messageId,
        id: question.id,
        text: question.text,
        blocking: question.blocking,
      });
    }
    for (const resolved of reply.resolve) {
      appendDiscussionEvent(this.roomId, {
        type: 'question_resolved',
        for_message: messageId,
        id: resolved.id,
        ...(resolved.answer ? { answer: resolved.answer } : {}),
      });
    }
    const after = this.room();
    if (after.dialogue.ready && after.phase !== 'converging') {
      appendDiscussionEvent(this.roomId, { type: 'phase_changed', phase: 'converging', round: 1 });
    } else if (!after.dialogue.ready && after.phase === 'framing' && replyTo) {
      appendDiscussionEvent(this.roomId, { type: 'phase_changed', phase: 'exploring', round: 1 });
    }
  }

  private async consult(teammate: DiscussionParticipant, question: string): Promise<void> {
    const room = this.room();
    appendDiscussionEvent(this.roomId, { type: 'turn_started', speaker: teammate.id });
    const result = await this.options.speaker.speak({
      room,
      participant: teammate,
      intent: 'respond_human',
      humanPrompt: question,
    });
    appendDiscussionEvent(this.roomId, {
      type: 'message',
      id: `msg-${randomUUID().slice(0, 10)}`,
      speaker: teammate.id,
      text: result.text,
      performative: result.performative,
      stance: result.stance,
      round: 1,
      consulted: true,
    });
  }

  private postSummary(room: DiscussionRoomState): void {
    const locale = room.config.locale;
    const { summary } = loadDiscussionCopy().dialogue;
    const goal = room.dialogue;
    const list = (items: string[]) =>
      items.length ? items.map((item) => `- ${item}`).join('\n') : summary.none[locale];
    const open = goal.questions.filter((q) => q.status === 'open').map((q) => q.text);
    const text = [
      `### ${summary.title[locale]}`,
      `**${summary.objective[locale]}**: ${goal.objective || room.goal}`,
      `**${summary.criteria[locale]}**\n${list(goal.success_criteria)}`,
      `**${summary.constraints[locale]}**\n${list([...goal.constraints, ...goal.assumptions])}`,
      `**${summary.decisions[locale]}**\n${list(goal.decisions)}`,
      `**${summary.open[locale]}**\n${list(open)}`,
    ].join('\n\n');
    const facilitator = this.facilitator(room);
    appendDiscussionEvent(this.roomId, {
      type: 'message',
      id: `msg-${randomUUID().slice(0, 10)}`,
      speaker: facilitator.id,
      text,
      performative: 'summarize',
      stance: 'neutral',
      round: 1,
    });
  }

  /** Turn what the conversation established into a decision, then into the brief and its outcomes. */
  private async conclude(): Promise<void> {
    const room = this.room();
    const facilitator = this.facilitator(room);
    if (room.phase !== 'converging') {
      appendDiscussionEvent(this.roomId, { type: 'phase_changed', phase: 'converging', round: 1 });
    }
    const draft = await this.options.speaker.conclude({
      room: this.room(),
      participant: facilitator,
      intent: 'conclude',
    });
    appendDiscussionEvent(this.roomId, {
      type: 'decision',
      summary: draft.summary,
      agreements: draft.agreements,
      dissent: draft.dissent,
      next_steps: draft.next_steps,
      consensus: this.room().dialogue.readiness,
      concluded_by: facilitator.id,
    });
    publishDiscussionOutcomes(this.roomId);
  }
}
