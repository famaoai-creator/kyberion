import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approvalRequestLogicalPath,
  createSurfaceApprovalRequest,
  loadApprovalRequest,
  safeRmSync,
  withExecutionContext,
} from '@agent/core';

vi.mock('discord.js', () => ({
  Client: class MockClient {},
  GatewayIntentBits: {},
  Events: {},
}));

import {
  buildDiscordThreadContextFromEntries,
  handleDiscordInteraction,
  type DiscordThreadHistoryEntry,
} from './index.js';

const RUN_ID = `${process.pid}-${Date.now()}`;
let approvalId: string | undefined;

afterEach(() => {
  withExecutionContext('surface_runtime', () => {
    if (approvalId) {
      safeRmSync(approvalRequestLogicalPath('discord', approvalId), { force: true });
      approvalId = undefined;
    }
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
