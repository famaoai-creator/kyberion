import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approvalRequestLogicalPath,
  createSurfaceApprovalRequest,
  loadApprovalRequest,
  pathResolver,
  safeRmSync,
  withExecutionContext,
} from '@agent/core';
import type { SurfaceConversationMessageInput, SurfaceConversationResult } from '@agent/core';

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

import {
  buildTelegramThreadContextFromEntries,
  handleTelegramCallbackQuery,
  handleTelegramUpdate,
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

const historyChatId = `tg-m1-${RUN_ID}`;

afterEach(() => {
  captured.conversationInputs.length = 0;
  withExecutionContext('surface_runtime', () => {
    safeRmSync(
      pathResolver.resolve(
        `active/shared/runtime/telegram-bridge/thread-history/${historyChatId}.jsonl`
      ),
      { force: true }
    );
  });
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

  it('never leaks the incoming message into its own thread context', async () => {
    // m1: the user entry used to be appended BEFORE the context was built, so
    // the message appeared in its own context and evicted a real prior turn
    // from the 6-entry window.
    process.env.KYBERION_SURFACE_ALLOWLISTS = JSON.stringify({ telegram: ['77'] });
    const send = (messageId: number, text: string) =>
      handleTelegramUpdate(
        {
          message: {
            message_id: messageId,
            date: 1_700_000_000 + messageId,
            chat: { id: historyChatId },
            from: { id: '77', username: 'alice' },
            text,
          },
        },
        { dryRun: true }
      );

    await send(1, '最初の相談');
    await send(2, 'それで、どうなりましたか');

    expect(captured.conversationInputs).toHaveLength(2);
    expect(captured.conversationInputs[0].threadContext).toBeUndefined();
    expect(captured.conversationInputs[1].threadContext).toContain('User (alice): 最初の相談');
    expect(captured.conversationInputs[1].threadContext).not.toContain('それで、どうなりましたか');
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
