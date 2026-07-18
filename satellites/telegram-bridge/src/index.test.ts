import { afterEach, describe, expect, it } from 'vitest';
import {
  approvalRequestLogicalPath,
  createSurfaceApprovalRequest,
  loadApprovalRequest,
  safeRmSync,
  withExecutionContext,
} from '@agent/core';

import {
  buildTelegramThreadContextFromEntries,
  handleTelegramCallbackQuery,
  type TelegramThreadHistoryEntry,
} from './index.js';

const RUN_ID = `${process.pid}-${Date.now()}`;

afterEach(() => {
  withExecutionContext('surface_runtime', () => {
    if (process.env.TEST_APPROVAL_ID) {
      const record = loadApprovalRequest('telegram', process.env.TEST_APPROVAL_ID);
      if (record) safeRmSync(approvalRequestLogicalPath('telegram', record.id), { force: true });
    }
  });
  delete process.env.KYBERION_SURFACE_ALLOWLISTS;
  delete process.env.TEST_APPROVAL_ID;
});

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

  it('routes a Telegram callback query through the shared approval decision API', async () => {
    process.env.KYBERION_SURFACE_ALLOWLISTS = JSON.stringify({ telegram: ['42'] });
    const record = createSurfaceApprovalRequest({
      surface: 'telegram',
      channel: 'chat-approval',
      threadTs: 'chat-approval',
      correlationId: `telegram-bridge-test-${RUN_ID}`,
      requestedBy: 'telegram-surface-agent',
      draft: { title: 'Deploy', summary: 'Deploy the reviewed change.' },
    });
    process.env.TEST_APPROVAL_ID = record.id;

    const receipt = await handleTelegramCallbackQuery(
      {
        id: 'callback-1',
        from: { id: '42' },
        message: { message_id: 10, chat: { id: 'chat-approval' } },
        data: `appr:${record.id}:approve`,
      },
      { dryRun: true }
    );

    expect(receipt).toMatchObject({ ok: true, chatId: 'chat-approval' });
    expect(loadApprovalRequest('telegram', record.id)).toMatchObject({ status: 'approved' });
  });
});
