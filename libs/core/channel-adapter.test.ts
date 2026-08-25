import { describe, expect, it } from 'vitest';
import {
  formatChannelThreadContext,
  runChannelTurn,
  type ChannelAdapter,
} from './channel-adapter.js';

describe('formatChannelThreadContext', () => {
  it('normalizes recent provider messages while preserving speaker labels', () => {
    expect(
      formatChannelThreadContext('Slack', [
        { role: 'user', authorLabel: 'alice', text: 'Hello' },
        { role: 'assistant', authorLabel: 'bot', text: 'Hi there' },
      ])
    ).toBe('Recent Slack thread context:\nUser (alice): Hello\nAssistant: Hi there');
  });

  it('returns no context for empty or whitespace-only history', () => {
    expect(
      formatChannelThreadContext('Slack', [{ role: 'user', authorLabel: 'alice', text: '   ' }])
    ).toBeUndefined();
  });
});

describe('runChannelTurn', () => {
  it('keeps thread context, typing, conversation, delivery, and cleanup ordered', async () => {
    const calls: string[] = [];
    const adapter: ChannelAdapter = {
      channel: 'telegram',
      actorId: 'operator-1',
      threadContext: () => {
        calls.push('thread');
        return 'previous';
      },
      typing: () => {
        calls.push('typing:start');
        return { stop: () => calls.push('typing:stop') };
      },
      send: (message) => calls.push(`send:${message.text}`),
    };
    const result = await runChannelTurn(
      adapter,
      { text: 'hello', channel: 'c', threadTs: 't' },
      (input) => {
        calls.push(`conversation:${input.threadContext}:${input.actorId}`);
        return {
          text: 'reply',
          a2uiMessages: [],
          a2aMessages: [],
          delegationResults: [],
          approvalRequests: [],
        };
      }
    );

    expect(result.text).toBe('reply');
    expect(calls).toEqual([
      'thread',
      'typing:start',
      'conversation:previous:operator-1',
      'send:reply',
      'typing:stop',
    ]);
  });

  it('stops typing even when conversation fails', async () => {
    const calls: string[] = [];
    await expect(
      runChannelTurn(
        {
          channel: 'discord',
          actorId: 'operator-1',
          typing: () => ({ stop: () => calls.push('stop') }),
          send: () => undefined,
        },
        { text: 'hello', channel: 'c', threadTs: 't' },
        () => Promise.reject(new Error('failed'))
      )
    ).rejects.toThrow('failed');
    expect(calls).toEqual(['stop']);
  });
});
