import { describe, expect, it, vi } from 'vitest';
import type {
  ChannelAdapter,
  SurfaceConversationMessageInput,
  SurfaceConversationResult,
} from '@agent/core';

vi.mock('@slack/bolt', () => ({
  App: class MockApp {},
  LogLevel: {},
}));

const captured = vi.hoisted(() => ({
  conversationInputs: [] as { threadContext?: string; text: string }[],
}));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    runSurfaceMessageConversation: async (input: SurfaceConversationMessageInput) => {
      captured.conversationInputs.push({
        threadContext: input.threadContext,
        text: input.text,
      });
      return {
        text: 'ok',
        a2uiMessages: [],
        a2aMessages: [],
        delegationResults: [],
        approvalRequests: [],
      } satisfies SurfaceConversationResult;
    },
  };
});

import { runSlackChannelTurn } from './index.js';

const THREAD_CONTEXT = 'Recent Slack thread context:\nUser (alice): 最初の相談';

function baseRequest() {
  return {
    text: 'それで、どうなりましたか',
    channel: 'C-thread',
    threadTs: '1700000000.000100',
    correlationId: 'slack-bridge-test',
    receivedAt: '1700000001.000200',
    actorId: 'U-operator',
  };
}

describe('slack bridge channel turn', () => {
  it('forwards the collected thread context into the conversation', async () => {
    captured.conversationInputs.length = 0;
    const sent: string[] = [];
    const adapter: ChannelAdapter = {
      channel: 'slack',
      actorId: 'U-operator',
      threadContext: () => THREAD_CONTEXT,
      send: ({ text }) => {
        sent.push(text);
      },
    };

    const result = await runSlackChannelTurn(adapter, baseRequest());

    expect(captured.conversationInputs).toHaveLength(1);
    expect(captured.conversationInputs[0].threadContext).toBe(THREAD_CONTEXT);
    expect(result.text).toBe('ok');
    expect(sent).toEqual(['ok']);
  });

  it('runs the post-turn envelope callback before the typing reaction clears', async () => {
    captured.conversationInputs.length = 0;
    const calls: string[] = [];
    const adapter: ChannelAdapter = {
      channel: 'slack',
      actorId: 'U-operator',
      typing: () => ({
        stop: () => {
          calls.push('typing:stop');
        },
      }),
      shouldSend: () => false,
      send: () => {
        calls.push('send');
      },
    };

    await runSlackChannelTurn(adapter, baseRequest(), {
      afterTurn: () => {
        calls.push('afterTurn');
      },
    });

    expect(calls).toEqual(['afterTurn', 'typing:stop']);
  });
});
