import type { EventScopeInput } from './event-scope.js';
import type { SurfaceAsyncChannel, SurfaceConversationResult } from './channel-surface-types.js';

export interface ChannelTurnInput {
  text: string;
  channel: string;
  threadTs: string;
  metadata?: Record<string, unknown>;
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
export function formatChannelTurnText(result: SurfaceConversationResult): string {
  const text = result.text.trim();
  const contract = result.intentResolution;
  if (!text || !contract || text.includes('Intent:') || text.includes('Understanding:')) {
    return result.text;
  }
  return [
    text,
    '',
    `Understanding: ${contract.normalized_intent}`,
    `Missing input: ${
      contract.missing_inputs.length > 0 ? contract.missing_inputs.join(', ') : 'none'
    }`,
    `Next action: ${contract.next_action.label}`,
    `Consequence: ${contract.next_action.consequence}`,
    `Outcome: ${contract.outcome_kind}`,
  ].join('\n');
}

/** Run the common thread-context, typing, conversation, and delivery sequence. */
export async function runChannelTurn(
  adapter: ChannelAdapter,
  input: ChannelTurnInput,
  conversation: ChannelTurnConversation
): Promise<SurfaceConversationResult> {
  const threadContext = adapter.threadContext ? await adapter.threadContext(input) : undefined;
  const typing = adapter.typing ? await adapter.typing(input) : undefined;
  try {
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
    if (deliveredResult.text.trim()) {
      await adapter.send({
        text: deliveredResult.text,
        channel: input.channel,
        threadTs: input.threadTs,
        result: deliveredResult,
      });
    }
    return deliveredResult;
  } finally {
    await typing?.stop();
  }
}
