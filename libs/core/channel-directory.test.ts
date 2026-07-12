import { describe, expect, it } from 'vitest';
import {
  formatChannelDirectoryEntry,
  getChannelDirectoryEntry,
  listChannelDirectoryEntries,
} from './channel-directory.js';

describe('channel-directory', () => {
  it('lists the governed channel directory entries in stable order', () => {
    const entries = listChannelDirectoryEntries();

    expect(entries.map((entry) => entry.channel)).toEqual([
      'chronos',
      'cli',
      'cowork',
      'discord',
      'imessage',
      'presence',
      'slack',
      'telegram',
    ]);
  });

  it('exposes human-friendly routing and coordination targets for slack', () => {
    const slack = getChannelDirectoryEntry('slack');

    expect(slack).toMatchObject({
      channel: 'slack',
      displayName: 'Slack',
      agentId: 'slack-surface-agent',
      directReply: 'outbox',
      coordinationRoot: 'active/shared/coordination/channels/slack',
      requestDir: 'active/shared/coordination/channels/slack/requests',
      notificationDir: 'active/shared/coordination/channels/slack/notifications',
      outboxDir: 'active/shared/coordination/channels/slack/outbox',
    });
    expect(slack?.status).toBe('shipped');
    expect(slack?.manifestPath).toContain('surface-provider-manifests.json');
  });

  it('exposes the presence runtime roots without an outbox path', () => {
    const presence = getChannelDirectoryEntry('presence');

    expect(presence).toMatchObject({
      channel: 'presence',
      displayName: 'Presence',
      agentId: 'presence-surface-agent',
      directReply: 'notification',
      coordinationRoot: 'active/shared/runtime/presence',
      requestDir: 'active/shared/runtime/presence/requests',
      notificationDir: 'active/shared/runtime/presence/notifications',
    });
    expect(presence?.outboxDir).toBeUndefined();
  });

  it('formats a readable summary block', () => {
    const slack = getChannelDirectoryEntry('slack');
    expect(slack).not.toBeNull();
    const lines = formatChannelDirectoryEntry(slack!);

    expect(lines[0]).toBe('Slack (slack)');
    expect(lines).toContain('  agent: slack-surface-agent');
    expect(lines).toContain('  coordination root: active/shared/coordination/channels/slack');
    expect(lines).toContain('  outbox dir: active/shared/coordination/channels/slack/outbox');
  });
});
