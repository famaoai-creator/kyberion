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

vi.mock('discord.js', () => ({
  Client: class MockClient {},
  GatewayIntentBits: {},
  Events: {},
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

import {
  buildDiscordThreadContextFromEntries,
  handleDiscordInteraction,
  handleDiscordMessage,
  type DiscordThreadHistoryEntry,
} from './index.js';

const RUN_ID = `${process.pid}-${Date.now()}`;
const historyChannelId = `dc-m1-${RUN_ID}`;
let approvalId: string | undefined;

afterEach(() => {
  captured.conversationInputs.length = 0;
  withExecutionContext('surface_runtime', () => {
    if (approvalId) {
      safeRmSync(approvalRequestLogicalPath('discord', approvalId), { force: true });
      approvalId = undefined;
    }
    safeRmSync(
      pathResolver.resolve(
        `active/shared/runtime/discord-bridge/thread-history/${historyChannelId}.jsonl`
      ),
      { force: true }
    );
  });
  delete process.env.KYBERION_SURFACE_ALLOWLISTS;
});

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

  it('never leaks the incoming message into its own fallback thread context', async () => {
    // m1: the fallback path (no gateway history available) re-read the persisted
    // history AFTER the user entry was appended, so the message appeared in its
    // own context and evicted a real prior turn from the window.
    process.env.KYBERION_SURFACE_ALLOWLISTS = JSON.stringify({ discord: ['actor-m1'] });
    const send = (id: string, content: string) =>
      handleDiscordMessage({
        author: { bot: false, id: 'actor-m1', tag: 'alice#0001' },
        content,
        id,
        channelId: historyChannelId,
        createdAt: new Date(`2026-05-15T00:0${id}:00.000Z`),
        // No `channel.messages.fetch` — force the persisted-history fallback.
        channel: {},
        reply: vi.fn().mockResolvedValue(undefined),
      } as any);

    await send('1', '最初の相談');
    await send('2', 'それで、どうなりましたか');

    expect(captured.conversationInputs).toHaveLength(2);
    expect(captured.conversationInputs[0].threadContext).toBeUndefined();
    expect(captured.conversationInputs[1].threadContext).toContain(
      'User (alice#0001): 最初の相談'
    );
    expect(captured.conversationInputs[1].threadContext).not.toContain('それで、どうなりましたか');
  });

  it('routes a Discord button interaction through the shared approval decision API', async () => {
    process.env.KYBERION_SURFACE_ALLOWLISTS = JSON.stringify({ discord: ['actor-42'] });
    const record = createSurfaceApprovalRequest({
      surface: 'discord',
      channel: 'channel-approval',
      threadTs: 'channel-approval',
      correlationId: `discord-bridge-test-${RUN_ID}`,
      requestedBy: 'discord-surface-agent',
      draft: { title: 'Deploy', summary: 'Deploy the reviewed change.' },
    });
    approvalId = record.id;
    const reply = vi.fn().mockResolvedValue(undefined);

    await handleDiscordInteraction({
      isButton: () => true,
      user: { id: 'actor-42' },
      channelId: 'channel-approval',
      customId: `appr:${record.id}:approve`,
      reply,
    });

    expect(reply).toHaveBeenCalledWith({ content: '承認しました: Deploy', ephemeral: true });
    expect(loadApprovalRequest('discord', record.id)).toMatchObject({ status: 'approved' });
  });
});
