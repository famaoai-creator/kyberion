import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSurfaceOutboxMessage,
  listSurfaceNotifications,
  listSurfaceOutboxMessages,
} from './channel-surface.js';
import {
  buildChronosSurfaceIngressEnvelope,
  buildPresenceSurfaceIngressEnvelope,
  buildSlackSurfaceIngressEnvelope,
} from './surface-ingress-contract.js';
import {
  buildSurfaceConversationInputFromMessage,
  buildSurfaceConversationInput,
  createChronosSurfaceMessage,
  createPresenceSurfaceMessage,
  createSlackSurfaceMessage,
  createSurfaceSpace,
  SurfaceUnsupportedActionError,
} from './surface-interaction-model.js';
import { pathResolver } from './path-resolver.js';
import { safeRmSync } from './secure-io.js';

function cleanupSurfaceArtifacts(): void {
  const previousRole = process.env.MISSION_ROLE;
  process.env.MISSION_ROLE = 'slack_bridge';
  for (const message of listSurfaceOutboxMessages('slack')) {
    clearSurfaceOutboxMessage('slack', message.message_id);
  }
  safeRmSync(pathResolver.resolve('active/shared/coordination/channels/slack/notifications'), { recursive: true, force: true });
  if (previousRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = previousRole;
}

describe('surface-interaction-model', () => {
  afterEach(() => {
    cleanupSurfaceArtifacts();
  });

  it('wraps a slack input as a replyable message object', () => {
    const message = createSlackSurfaceMessage({
      user: 'U123',
      text: 'レビューして',
      channel: 'C123',
      ts: '1710000000.100',
      correlationId: 'corr-1',
    });

    const receipt = message.reply({ text: 'acknowledged', source: 'surface' });

    expect(receipt.mode).toBe('outbox');
    const outbox = listSurfaceOutboxMessages('slack');
    expect(outbox.some((entry) =>
      entry.channel === 'C123' &&
      entry.thread_ts === '1710000000.100' &&
      entry.text === 'acknowledged' &&
      entry.correlation_id === 'corr-1'
    )).toBe(true);
  });

  it('builds normalized surface conversation input from surface messages', () => {
    const slackEnvelope = buildSlackSurfaceIngressEnvelope({
      user: 'U123',
      text: 'レビューして',
      channel: 'C123',
      ts: '1710000000.100',
      correlationId: 'corr-1',
      channelType: 'im',
    });
    expect(slackEnvelope.surface).toBe('slack');
    expect(slackEnvelope.threadTs).toBe('1710000000.100');
    expect(slackEnvelope.metadata?.channelType).toBe('im');

    const slackMessage = createSlackSurfaceMessage({
      user: 'U123',
      text: 'レビューして',
      channel: 'C123',
      ts: '1710000000.100',
      correlationId: 'corr-1',
    });
    const slackInput = buildSurfaceConversationInputFromMessage(slackMessage, {
      agentId: 'slack-surface-agent',
      senderAgentId: 'kyberion:slack-bridge',
      forcedReceiver: 'nerve-agent',
      slack: {
        user: 'U123',
        channelType: 'im',
      },
    });
    expect(slackInput.query).toContain('Surface: slack');
    expect(slackInput.query).toContain('Channel: C123');
    expect(slackInput.query).toContain('User message:\nレビューして');
    expect(slackInput.forcedReceiver).toBe('nerve-agent');

    const chronosEnvelope = buildChronosSurfaceIngressEnvelope({
      text: 'システム状態を教えて',
      sessionId: 'chronos-1',
    });
    expect(chronosEnvelope.surface).toBe('chronos');
    expect(chronosEnvelope.channel).toBe('chronos');

    const chronosMessage = createChronosSurfaceMessage({
      text: 'システム状態を教えて',
      sessionId: 'chronos-1',
      requesterId: 'chronos-ui',
    });
    const chronosInput = buildSurfaceConversationInputFromMessage(chronosMessage, {
      agentId: 'chronos-mirror',
      senderAgentId: 'chronos-mirror',
    });
    expect(chronosInput.query).toBe('システム状態を教えて');

    const presenceEnvelope = buildPresenceSurfaceIngressEnvelope({
      text: 'ブラウザを開いて',
      channel: 'voice',
      threadTs: 'voice-1',
    });
    expect(presenceEnvelope.surface).toBe('presence');
    expect(presenceEnvelope.channel).toBe('voice');

    const presenceMessage = createPresenceSurfaceMessage({
      text: 'ブラウザを開いて',
      channel: 'voice',
      threadTs: 'voice-1',
      speakerId: 'user-voice',
    });
    const presenceInput = buildSurfaceConversationInputFromMessage(presenceMessage, {
      agentId: 'presence-surface-agent',
      senderAgentId: 'kyberion:voice-hub',
    });
    expect(presenceInput.query).toBe('ブラウザを開いて');

    const unifiedSlackInput = buildSurfaceConversationInput({
      surface: 'slack',
      text: '見積もりをレビューして',
      channel: 'C777',
      threadTs: '1710000000.777',
      senderAgentId: 'kyberion:slack-bridge',
      forcedReceiver: 'nerve-agent',
      metadata: {
        user: 'U777',
        channelType: 'im',
      },
    });
    expect(unifiedSlackInput.agentId).toBe('slack-surface-agent');
    expect(unifiedSlackInput.query).toContain('User message:\n見積もりをレビューして');
    expect(unifiedSlackInput.surface).toBe('slack');
    expect(unifiedSlackInput.surfaceText).toBe('見積もりをレビューして');
    expect(unifiedSlackInput.surfaceMetadata?.user).toBe('U777');
    expect(unifiedSlackInput.surfaceMetadata?.channelType).toBe('im');
  });

  it('fails explicitly when a surface does not support direct reply', () => {
    const presence = createSurfaceSpace({
      surface: 'presence',
      channel: 'voice',
      threadTs: 'voice-thread',
      correlationId: 'corr-voice',
      actorId: 'presence-surface-agent',
    });

    expect(() => presence.reply({ text: 'hello' })).toThrow(SurfaceUnsupportedActionError);
  });

  it('surfaces responding lifecycle notifications through the space object', async () => {
    const slack = createSurfaceSpace({
      surface: 'slack',
      channel: 'C999',
      threadTs: '1710000000.999',
      correlationId: 'corr-slack',
      actorId: 'slack-surface-agent',
    });

    const result = await slack.responding(
      async () => 'done',
      {
        title: 'Slack Task',
        startedText: 'processing started',
        completedText: 'processing completed',
        sourceAgentId: 'slack-surface-agent',
        requestId: 'REQ-SLACK-1',
      },
    );

    expect(result).toBe('done');
    const notifications = listSurfaceNotifications('slack');
    expect(notifications.some((entry) => entry.status === 'info' && entry.request_id === 'REQ-SLACK-1')).toBe(true);
    expect(notifications.some((entry) => entry.status === 'success' && entry.request_id === 'REQ-SLACK-1')).toBe(true);
  });
});
