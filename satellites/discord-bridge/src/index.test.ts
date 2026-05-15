import { describe, expect, it } from 'vitest';

import { vi } from 'vitest';

vi.mock('discord.js', () => ({
  Client: class MockClient {},
  GatewayIntentBits: {},
  Events: {},
}));

import { buildDiscordThreadContextFromEntries, type DiscordThreadHistoryEntry } from './index.js';

describe('discord bridge thread context', () => {
  it('formats recent user and assistant entries', () => {
    const entries: DiscordThreadHistoryEntry[] = [
      {
        role: 'user',
        authorLabel: 'alice#0001',
        text: '最初の相談',
        messageId: '1',
        threadTs: 'channel-1',
        channelId: 'channel-1',
        receivedAt: '2026-05-15T00:00:00.000Z',
      },
      {
        role: 'assistant',
        authorLabel: 'discord-surface-agent',
        text: '確認しました',
        messageId: '2',
        threadTs: 'channel-1',
        channelId: 'channel-1',
        receivedAt: '2026-05-15T00:01:00.000Z',
      },
    ];

    const context = buildDiscordThreadContextFromEntries(entries);

    expect(context).toContain('Recent Discord thread context:');
    expect(context).toContain('User (alice#0001): 最初の相談');
    expect(context).toContain('Assistant: 確認しました');
  });

  it('returns undefined for empty history', () => {
    expect(buildDiscordThreadContextFromEntries([])).toBeUndefined();
  });
});
