import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  approvalRequestLogicalPath,
  loadApprovalRequest,
} from '@agent/core/governance/approval-store';
import { buildBridgeEmptyReplyText } from '@agent/core/bridge-error-reply';
import { createSurfaceApprovalRequest } from '@agent/core/surface/channel-surface';
import { withExecutionContext } from '@agent/core/authority';
import { resolveOperatorLocale } from '@agent/core/surface/operator-identity';
import { t } from '@agent/core/t';
import * as pathResolver from '@agent/core/path-resolver';
import { safeReadFile, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import type {
  SurfaceConversationMessageInput,
  SurfaceConversationResult,
} from '@agent/core/surface/channel-surface-types';

const captured = vi.hoisted(() => ({
  conversationInputs: [] as { threadContext?: string; text: string; locale?: string }[],
  replyText: 'ok',
}));

vi.mock('@agent/core/surface/channel-surface', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/surface/channel-surface')>();
  return {
    ...actual,
    runSurfaceMessageConversation: async (input: SurfaceConversationMessageInput) => {
      captured.conversationInputs.push({
        threadContext: input.threadContext,
        text: input.text,
        locale: input.locale,
      });
      return {
        text: captured.replyText,
        a2uiMessages: [],
        a2aMessages: [],
        delegationResults: [],
        approvalRequests: [],
      } satisfies SurfaceConversationResult;
    },
  };
});

import {
  buildTelegramApprovalReplyMarkup,
  buildTelegramThreadContextFromEntries,
  handleTelegramCallbackQuery,
  handleTelegramUpdate,
  parseTelegramBridgeInput,
  parseTelegramThreadHistoryEntry,
  parseTelegramSendInput,
  readTelegramJsonObject,
  resolveTelegramApprovalText,
  resolveTelegramBridgeInputPath,
  resolveTelegramThreadHistoryPath,
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
  captured.replyText = 'ok';
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
  it('uses the shared script harness for direct server startup', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('satellites/telegram-bridge/src/index.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain(
      "import { defineScript, isDirectScript } from '@agent/core/script-harness'"
    );
    expect(source).toContain("name: 'telegram-bridge'");
    expect(source).toContain(
      "await main(['node', 'satellites/telegram-bridge/src/index.ts', ...argv])"
    );
    expect(source).not.toContain('args: string[] = process.argv');
    expect(source).not.toContain('main().catch(');
  });

  it('rejects malformed persisted thread history entries', () => {
    expect(parseTelegramThreadHistoryEntry(['invalid'])).toBeNull();
    expect(parseTelegramThreadHistoryEntry({ role: 'system' })).toBeNull();
    expect(
      parseTelegramThreadHistoryEntry({
        role: 'user',
        authorLabel: 'alice',
        text: 'hello',
        messageId: '1',
        threadTs: 'chat-1',
        chatId: 'chat-1',
        receivedAt: '2026-05-15T00:00:00.000Z',
      })
    ).toMatchObject({ role: 'user', text: 'hello' });
  });

  it('rejects a symlinked persisted thread history path before reading it', () => {
    const threadTs = `symlink-${RUN_ID}`;
    const linkedPath = resolveTelegramThreadHistoryPath(threadTs);
    const targetPath = pathResolver.resolve(
      `active/shared/tmp/telegram-thread-history-target-${RUN_ID}.jsonl`
    );
    withExecutionContext('surface_runtime', () => {
      safeWriteFile(targetPath, '{"role":"assistant"}\n');
      safeSymlinkSync(targetPath, linkedPath);
      try {
        expect(() => resolveTelegramThreadHistoryPath(threadTs)).toThrow('[RESOURCE_PATH_SYMLINK]');
      } finally {
        safeRmSync(linkedPath, { force: true });
        safeRmSync(targetPath, { force: true });
      }
    });
  });

  it('keeps file input inside the repository and limited to regular files', () => {
    expect(() => resolveTelegramBridgeInputPath('/tmp/telegram-input.json')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
    expect(() => resolveTelegramBridgeInputPath('scripts')).toThrow(
      'input must be an existing regular file'
    );
  });

  it('strictly validates direct send payloads before provider dispatch', () => {
    expect(parseTelegramSendInput({ chatId: 42, text: 'hello' })).toEqual({
      chatId: 42,
      text: 'hello',
    });
    expect(
      parseTelegramSendInput({ chatId: '@operator', text: 'hello', parseMode: 'Markdown' })
    ).toEqual({
      chatId: '@operator',
      text: 'hello',
      parseMode: 'Markdown',
    });
    expect(() => parseTelegramSendInput({ chatId: {}, text: 'hello' })).toThrow(
      'telegram send chatId'
    );
    expect(() => parseTelegramSendInput({ chatId: 42, text: ['hello'] })).toThrow(
      'telegram send text'
    );
    expect(() => parseTelegramSendInput({ chatId: 42, text: 'hello', extra: true })).toThrow(
      'unexpected telegram send field'
    );
  });

  it('validates persisted bridge envelopes before union narrowing', () => {
    expect(parseTelegramBridgeInput({ action: 'webhook', update: { update_id: 1 } })).toEqual({
      action: 'webhook',
      update: { update_id: 1 },
    });
    expect(() => parseTelegramBridgeInput(null)).toThrow(
      'telegram bridge input must be a JSON object'
    );
    expect(() => parseTelegramBridgeInput(['invalid'])).toThrow(
      'telegram bridge input must be a JSON object'
    );
    expect(() => parseTelegramBridgeInput({ action: 'unexpected' })).toThrow(
      'telegram bridge action must be send or webhook'
    );
    expect(() => parseTelegramBridgeInput({ update: ['invalid'] })).toThrow(
      'telegram bridge update must be a JSON object'
    );
  });

  it('rejects non-object HTTP JSON bodies before bridge dispatch', async () => {
    await expect(readTelegramJsonObject(Readable.from(['[]']) as never)).rejects.toThrow(
      'request body must be a JSON object'
    );
    await expect(readTelegramJsonObject(Readable.from(['null']) as never)).rejects.toThrow(
      'request body must be a JSON object'
    );
    await expect(
      readTelegramJsonObject(Readable.from(['{"message":{"constructor":{}}}']) as never)
    ).rejects.toThrow('request body contains a dangerous JSON key');
  });

  it('returns object JSON bodies for webhook and send dispatch', async () => {
    await expect(
      readTelegramJsonObject(Readable.from(['{"message":{}}']) as never)
    ).resolves.toEqual({
      message: {},
    });
  });

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

    const locale = resolveOperatorLocale();
    expect(context).toContain(t('bridge:thread_context', { channel: 'Telegram' }, locale));
    expect(context).toContain(
      t('bridge:thread_user', { author: 'alice', text: '最初の相談' }, locale)
    );
    expect(context).toContain(t('bridge:thread_assistant', { text: '了解しました' }, locale));
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
    // No explicit turn locale: the orchestrator derives it (user text > scope > operator).
    expect(captured.conversationInputs.map((input) => input.locale)).toEqual([
      undefined,
      undefined,
    ]);
    expect(captured.conversationInputs[1].threadContext).toContain(
      t('bridge:thread_user', { author: 'alice', text: '最初の相談' }, resolveOperatorLocale())
    );
    expect(captured.conversationInputs[1].threadContext).not.toContain('それで、どうなりましたか');
  });

  it('answers a whitespace-only conversation reply with the empty-reply text', async () => {
    // The shared channel-adapter delivery gate trims before sending, so a
    // whitespace-only reply is silence and must take the empty-reply path.
    process.env.KYBERION_SURFACE_ALLOWLISTS = JSON.stringify({ telegram: ['77'] });
    captured.replyText = '   \n\t  ';

    const receipt = await handleTelegramUpdate(
      {
        message: {
          message_id: 9,
          date: 1_700_000_009,
          chat: { id: historyChatId },
          from: { id: '77', username: 'alice' },
          text: 'こんにちは',
        },
      },
      { dryRun: true }
    );

    expect(receipt).toMatchObject({ ok: true, chatId: historyChatId });
    expect(receipt.reply?.text).toBe(
      buildBridgeEmptyReplyText({ locale: resolveOperatorLocale() })
    );
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

describe('telegram bridge decision cards', () => {
  const card = {
    question: 'Ship the billing change?',
    recommendation: 'Approve after CI is green.',
    riskTier: 'approve' as const,
    riskReasons: ['touches billing'],
    reversible: false,
    evidence: [],
  };

  function createRequest(suffix: string, withCard = true) {
    const record = createSurfaceApprovalRequest({
      surface: 'telegram',
      channel: 'chat-card',
      threadTs: 'chat-card',
      correlationId: `telegram-bridge-test-${RUN_ID}-${suffix}`,
      requestedBy: 'telegram-surface-agent',
      draft: { title: 'Billing change', summary: 'Adjust invoice rounding.' },
      ...(withCard ? { decisionCard: card } : {}),
    });
    process.env.TEST_APPROVAL_ID = record.id;
    return record;
  }

  it('lays out four card buttons two per row and keeps legacy requests at two', () => {
    const record = createRequest('markup');
    expect(
      buildTelegramApprovalReplyMarkup(record).inline_keyboard.map((row) =>
        row.map((button) => button.callback_data)
      )
    ).toEqual([
      [`appr:${record.id}:approve`, `appr:${record.id}:changes`],
      [`appr:${record.id}:reject`, `appr:${record.id}:explain`],
    ]);
    const legacy = createRequest('markup-legacy', false);
    expect(buildTelegramApprovalReplyMarkup(legacy).inline_keyboard).toHaveLength(1);
  });

  it('turns a reply to the changes prompt into a change instruction', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const text = `Reply with changes: X\nappr:${id}:changes`;
    const botPrompt = { message_id: 1, text, from: { id: 1, is_bot: true } };
    expect(
      resolveTelegramApprovalText(
        { message_id: 2, chat: { id: 'c' }, reply_to_message: botPrompt } as never,
        'shorten it'
      )
    ).toBe(`appr:${id}:changes shorten it`);
    const userMessage = { message_id: 1, text, from: { id: 99, is_bot: false } };
    expect(
      resolveTelegramApprovalText(
        { message_id: 2, chat: { id: 'c' }, reply_to_message: userMessage } as never,
        'ok go ahead'
      )
    ).toBe('ok go ahead');
    expect(resolveTelegramApprovalText({ message_id: 3, chat: { id: 'c' } } as never, 'hi')).toBe(
      'hi'
    );
  });

  it('ignores card buttons from a sender outside the allowlist', async () => {
    process.env.KYBERION_SURFACE_ALLOWLISTS = JSON.stringify({ telegram: ['42'] });
    const record = createRequest('unauthorized');
    const receipt = await handleTelegramCallbackQuery(
      {
        id: 'callback-unauthorized',
        from: { id: '7' },
        message: { message_id: 10, chat: { id: 'chat-card' } },
        data: `appr:${record.id}:changes stop`,
      },
      { dryRun: true }
    );
    expect(receipt).toMatchObject({ ignored: true, reason: 'unauthorized_sender' });
    expect(loadApprovalRequest('telegram', record.id)).toMatchObject({ status: 'pending' });
  });

  it('answers the explain button without deciding the request', async () => {
    process.env.KYBERION_SURFACE_ALLOWLISTS = JSON.stringify({ telegram: ['42'] });
    const record = createRequest('explain');
    const receipt = await handleTelegramCallbackQuery(
      {
        id: 'callback-explain',
        from: { id: '42' },
        message: { message_id: 10, chat: { id: 'chat-card' } },
        data: `appr:${record.id}:explain`,
      },
      { dryRun: true }
    );
    expect(receipt).toMatchObject({ ok: true, chatId: 'chat-card' });
    expect(receipt.reply?.text).toContain('touches billing');
    expect(loadApprovalRequest('telegram', record.id)).toMatchObject({ status: 'pending' });
  });

  it('records a reply to the changes prompt as a rejection with the instruction', async () => {
    process.env.KYBERION_SURFACE_ALLOWLISTS = JSON.stringify({ telegram: ['42'] });
    const record = createRequest('changes');
    await handleTelegramUpdate(
      {
        message: {
          message_id: 11,
          date: 1_700_000_011,
          chat: { id: 'chat-card' },
          from: { id: '42', username: 'operator' },
          text: 'round half-even instead',
          reply_to_message: {
            message_id: 10,
            text: `prompt\nappr:${record.id}:changes`,
            from: { id: 1, is_bot: true },
          },
        },
      },
      { dryRun: true }
    );
    expect(loadApprovalRequest('telegram', record.id)).toMatchObject({
      status: 'rejected',
      changeRequest: { instruction: 'round half-even instead' },
    });
  });
});
