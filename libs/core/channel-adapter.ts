import type { EventScopeInput } from './event-scope.js';
import type {
  SurfaceAsyncChannel,
  SurfaceConversationAttachment,
  SurfaceConversationResult,
} from './channel-surface-types.js';

export interface ChannelTurnInput {
  text: string;
  channel: string;
  threadTs: string;
  metadata?: Record<string, unknown>;
  attachments?: SurfaceConversationAttachment[];
  scope?: EventScopeInput;
}

export interface ChannelTurnMessage {
  text: string;
  channel: string;
  threadTs: string;
  result: SurfaceConversationResult;
}

export interface ChannelTypingHandle {
  stop(): void | Promise<void>;
}

export interface ChannelThreadContextEntry {
  role: 'user' | 'assistant';
  authorLabel: string;
  text: string;
}

/** Format provider-neutral recent history for a channel turn. */
export function formatChannelThreadContext(
  channelLabel: string,
  entries: readonly ChannelThreadContextEntry[]
): string | undefined {
  const recent = entries.filter((entry) => entry.text.trim().length > 0).slice(-6);
  if (!recent.length) return undefined;

  return [
    `Recent ${channelLabel} thread context:`,
    ...recent.map((entry) =>
      entry.role === 'assistant'
        ? `Assistant: ${entry.text}`
        : `User (${entry.authorLabel}): ${entry.text}`
    ),
  ].join('\n');
}

/** Provider-specific I/O boundary shared by Slack, Telegram, Discord, and iMessage. */
export interface ChannelAdapter {
  readonly channel: SurfaceAsyncChannel;
  readonly actorId: string;
  threadContext?(input: ChannelTurnInput): string | undefined | Promise<string | undefined>;
  typing?(
    input: ChannelTurnInput
  ): ChannelTypingHandle | undefined | Promise<ChannelTypingHandle | undefined>;
  /** Gate common delivery when a bridge needs a proposal/approval envelope. */
  shouldSend?(message: ChannelTurnMessage): boolean | Promise<boolean>;
  send(message: ChannelTurnMessage): void | Promise<void>;
}

export type ChannelTurnConversation = (
  input: ChannelTurnInput & {
    threadContext?: string;
    surface: SurfaceAsyncChannel;
    actorId: string;
  }
) => SurfaceConversationResult | Promise<SurfaceConversationResult>;

/**
 * Keep approval and clarification outcomes visible on text-only channels.
 * Autonomous replies remain untouched; the structured contract is already
 * sufficient for surfaces that render cards.
 */
export function formatChannelTurnText(
  result: SurfaceConversationResult,
  options: { includeContract?: boolean } = {}
): string {
  const text = result.text.trim();
  const contract = result.intentResolution;
  const includeContract = options.includeContract ?? true;
  const contractNeedsOperatorAttention =
    contract?.authority_level === 'approval_required' ||
    contract?.authority_level === 'human_clarification_required' ||
    contract?.outcome_kind === 'approval_ready_plan';
  if (
    !text ||
    !contract ||
    !includeContract ||
    !contractNeedsOperatorAttention ||
    text.includes('Intent:') ||
    text.includes('Understanding:')
  ) {
    return result.text;
  }
  const japanese = /[ぁ-んァ-ン一-龯]/u.test(text);
  const labels = japanese
    ? {
        understanding: '理解',
        missingInput: '不足入力',
        nextAction: '次の操作',
        consequence: '帰結',
        outcome: '結果',
        none: 'なし',
      }
    : {
        understanding: 'Understanding',
        missingInput: 'Missing input',
        nextAction: 'Next action',
        consequence: 'Consequence',
        outcome: 'Outcome',
        none: 'none',
      };
  return [
    text,
    '',
    `${labels.understanding}: ${contract.normalized_intent}`,
    `${labels.missingInput}: ${
      contract.missing_inputs.length > 0 ? contract.missing_inputs.join(', ') : labels.none
    }`,
    `${labels.nextAction}: ${contract.next_action.label}`,
    `${labels.consequence}: ${contract.next_action.consequence}`,
    `${labels.outcome}: ${contract.outcome_kind}`,
  ].join('\n');
}

export interface RunChannelTurnOptions {
  /**
   * UX-02: post-turn provider sends a bridge performs itself — the
   * mission-proposal and approval envelopes that `shouldSend` deliberately
   * withholds from common delivery. They run while the typing indicator is
   * still active, so it stops only once the operator-visible work for this
   * turn is actually finished.
   */
  afterTurn?: (result: SurfaceConversationResult) => void | Promise<void>;
}

/** Run the common thread-context, typing, conversation, and delivery sequence. */
export async function runChannelTurn(
  adapter: ChannelAdapter,
  input: ChannelTurnInput,
  conversation: ChannelTurnConversation,
  options: RunChannelTurnOptions = {}
): Promise<SurfaceConversationResult> {
  let typing: ChannelTypingHandle | undefined;
  try {
    const threadContext = adapter.threadContext ? await adapter.threadContext(input) : undefined;
    typing = adapter.typing ? await adapter.typing(input) : undefined;
    const result = await conversation({
      ...input,
      ...(threadContext ? { threadContext } : {}),
      surface: adapter.channel,
      actorId: adapter.actorId,
    });
    const deliveredResult = {
      ...result,
      text: formatChannelTurnText(result),
    };
    const deliveryMessage = {
      text: deliveredResult.text,
      channel: input.channel,
      threadTs: input.threadTs,
      result: deliveredResult,
    };
    if (
      deliveredResult.text.trim() &&
      (adapter.shouldSend ? await adapter.shouldSend(deliveryMessage) : true)
    ) {
      await adapter.send(deliveryMessage);
    }
    await options.afterTurn?.(deliveredResult);
    return deliveredResult;
  } finally {
    await typing?.stop();
  }
}
