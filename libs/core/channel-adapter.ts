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
    if (result.text.trim()) {
      await adapter.send({
        text: result.text,
        channel: input.channel,
        threadTs: input.threadTs,
        result,
      });
    }
    return result;
  } finally {
    await typing?.stop();
  }
}
