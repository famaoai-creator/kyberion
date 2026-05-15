import { describe, expect, it } from 'vitest';

import { buildTelegramThreadContextFromEntries, type TelegramThreadHistoryEntry } from './index.js';

describe('telegram bridge thread context', () => {
  it('formats recent user and assistant entries', () => {
    const entries: TelegramThreadHistoryEntry[] = [
      {
        role: 'user',
        authorLabel: 'alice',
        text: '最初の相談',
        messageId: '1',
        threadTs: 'chat-1',
        chatId: 'chat-1',
        receivedAt: '2026-05-15T00:00:00.000Z',
      },
      {
        role: 'assistant',
        authorLabel: 'telegram-surface-agent',
        text: '了解しました',
        messageId: '2',
        threadTs: 'chat-1',
        chatId: 'chat-1',
        receivedAt: '2026-05-15T00:01:00.000Z',
      },
    ];

    const context = buildTelegramThreadContextFromEntries(entries);

    expect(context).toContain('Recent Telegram thread context:');
    expect(context).toContain('User (alice): 最初の相談');
    expect(context).toContain('Assistant: 了解しました');
  });

  it('returns undefined for empty history', () => {
    expect(buildTelegramThreadContextFromEntries([])).toBeUndefined();
  });
});
