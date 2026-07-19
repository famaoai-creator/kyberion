/**
 * Context rewind — "D-Mail" (KC-07, experimental).
 *
 * Lets a long-running worker collapse a failed exploration: revert its
 * transcript to a checkpoint taken before the dead end and carry back ONE
 * distilled lesson instead of the full failed tool traffic. Stronger context
 * hygiene than compaction (which summarizes; this deletes), and orthogonal to
 * it — pinned messages (OH-01 carryover) survive a rewind.
 *
 * Safety guards, in order:
 *  - a rewind can never undo real-world effects: any external effect recorded
 *    since the checkpoint refuses the rewind
 *  - at most one rewind per turn (beginTurn resets)
 *  - the lesson is length-capped so the "message from the future" cannot
 *    smuggle a new transcript in
 * Every rewind is recorded as a governance action and a `context_rewind`
 * worker event, so missions can observe rewind counts.
 *
 * Modeled on kimi-cli's DenwaRenji / SendDMail / BackToTheFuture.
 */

import { logger } from './core.js';
import type { ToolDefinition } from './reasoning-backend.js';
import type { WorkerContextMessage } from './worker-context-compaction.js';
import { getDefaultWorkerEventStream } from './worker-event-stream.js';

export const MAX_REWIND_LESSON_CHARS = 2_000;

export interface ContextCheckpoint {
  id: string;
  messageIndex: number;
  effectCount: number;
  createdAt: string;
}

export type ContextRewindRefusal =
  | 'unknown_checkpoint'
  | 'external_effects_since_checkpoint'
  | 'rewind_already_used_this_turn'
  | 'lesson_too_long';

export interface ContextRewindResult {
  rewound: boolean;
  refusal?: ContextRewindRefusal;
  droppedMessages?: number;
}

export class RewindableWorkerContext {
  private messages: WorkerContextMessage[];
  private readonly checkpoints = new Map<string, ContextCheckpoint>();
  private effectCount = 0;
  private rewindUsedThisTurn = false;
  private totalRewinds = 0;
  private checkpointSeq = 0;
  private readonly missionId: string | undefined;

  constructor(initialMessages: readonly WorkerContextMessage[] = [], missionId?: string) {
    this.messages = [...initialMessages];
    this.missionId = missionId;
  }

  getMessages(): readonly WorkerContextMessage[] {
    return this.messages;
  }

  append(message: WorkerContextMessage): void {
    this.messages.push(message);
  }

  /** Record a real-world (write/apply) effect — rewinds cannot cross it. */
  recordExternalEffect(description?: string): void {
    this.effectCount += 1;
    if (description) {
      logger.info(`[context-rewind] external effect recorded: ${description}`);
    }
  }

  /** Call at the start of each turn: re-arms the one-rewind-per-turn guard. */
  beginTurn(): void {
    this.rewindUsedThisTurn = false;
  }

  /** Take a checkpoint before a step; returns its id for later rewind. */
  checkpoint(): string {
    const id = `ckpt-${this.checkpointSeq++}`;
    this.checkpoints.set(id, {
      id,
      messageIndex: this.messages.length,
      effectCount: this.effectCount,
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  listCheckpoints(): ContextCheckpoint[] {
    return [...this.checkpoints.values()];
  }

  get rewindCount(): number {
    return this.totalRewinds;
  }

  rewindTo(checkpointId: string, lesson: string): ContextRewindResult {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) return { rewound: false, refusal: 'unknown_checkpoint' };
    if (lesson.length > MAX_REWIND_LESSON_CHARS) {
      return { rewound: false, refusal: 'lesson_too_long' };
    }
    if (this.rewindUsedThisTurn) {
      return { rewound: false, refusal: 'rewind_already_used_this_turn' };
    }
    if (this.effectCount > checkpoint.effectCount) {
      // Approved/applied real-world writes happened after this checkpoint —
      // rewinding the transcript would desynchronize it from reality.
      return { rewound: false, refusal: 'external_effects_since_checkpoint' };
    }

    const dropped = this.messages.slice(checkpoint.messageIndex);
    // OH-01 carryover and other pinned records survive the rewind: they are
    // state, not exploration.
    const survivingPinned = dropped.filter((message) => message.pinned);
    this.messages = [
      ...this.messages.slice(0, checkpoint.messageIndex),
      ...survivingPinned,
      {
        role: 'user',
        content: [
          '<system-reminder>',
          'You reverted a dead-end exploration back to an earlier checkpoint.',
          'Lesson carried back from the abandoned attempt:',
          lesson.trim(),
          'Do not repeat the abandoned approach; continue from here with this lesson applied.',
          '</system-reminder>',
        ].join('\n'),
      },
    ];
    // Checkpoints taken inside the discarded segment are no longer valid.
    for (const [id, entry] of this.checkpoints) {
      if (entry.messageIndex > checkpoint.messageIndex) this.checkpoints.delete(id);
    }
    this.rewindUsedThisTurn = true;
    this.totalRewinds += 1;

    const droppedCount = dropped.length - survivingPinned.length;
    void recordRewindObservability(this.missionId, checkpointId, droppedCount, this.totalRewinds);
    return { rewound: true, droppedMessages: droppedCount };
  }
}

async function recordRewindObservability(
  missionId: string | undefined,
  checkpointId: string,
  droppedMessages: number,
  totalRewinds: number
): Promise<void> {
  try {
    // Dynamic import: kill-switch drags in the agent-runtime plane.
    const { recordGovernanceAction } = await import('./kill-switch.js');
    recordGovernanceAction(
      'context-rewind',
      'context_rewind',
      `${missionId ?? 'no-mission'}:${checkpointId} dropped=${droppedMessages} total=${totalRewinds}`,
      false
    );
  } catch {
    /* observability is best-effort */
  }
  try {
    getDefaultWorkerEventStream().emit(
      'context_rewind',
      { checkpoint_id: checkpointId, dropped_messages: droppedMessages, total_rewinds: totalRewinds },
      missionId ? { mission_id: missionId } : undefined
    );
  } catch {
    /* observability is best-effort */
  }
}

/**
 * Tool surface for generateWithTools consumers: the model requests the rewind;
 * the hosting loop executes it via {@link RewindableWorkerContext.rewindTo}.
 */
export function buildContextRewindToolDefinition(): ToolDefinition {
  return {
    name: 'context_rewind',
    description:
      'Revert your own context to an earlier checkpoint after a dead-end exploration, ' +
      'carrying back a single distilled lesson. Refused if any real-world effect happened ' +
      `since that checkpoint. Lesson must be under ${MAX_REWIND_LESSON_CHARS} characters.`,
    inputSchema: {
      type: 'object',
      properties: {
        checkpoint_id: { type: 'string', description: 'Checkpoint to revert to' },
        lesson: {
          type: 'string',
          description: 'The one distilled lesson worth keeping from the abandoned attempt',
        },
      },
      required: ['checkpoint_id', 'lesson'],
    },
  };
}
