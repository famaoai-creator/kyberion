import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAdapter } from '@agent/core/surface/channel-adapter';
import { resolveOperatorLocale } from '@agent/core/surface/operator-identity';
import { t } from '@agent/core/t';
import type {
  SurfaceConversationMessageInput,
  SurfaceConversationResult,
} from '@agent/core/surface/channel-surface-types';
import { runSurfaceMessageConversation } from '@agent/core/surface/channel-surface';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

vi.mock('@slack/bolt', () => ({
  App: class MockApp {},
  LogLevel: {},
}));

const captured = vi.hoisted(() => ({
  conversationInputs: [] as {
    threadContext?: string;
    text: string;
    scope?: SurfaceConversationMessageInput['scope'];
    workAuthority?: SurfaceConversationMessageInput['workAuthority'];
    isolation?: SurfaceConversationMessageInput['isolation'];
    boundTenant?: string;
  }[],
}));

vi.mock('@agent/core/surface/channel-surface', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/surface/channel-surface')>();
  return {
    ...actual,
    runSurfaceMessageConversation: async (input: SurfaceConversationMessageInput) => {
      const { currentExecutionScope } = await import('@agent/core/foundation');
      captured.conversationInputs.push({
        isolation: input.isolation,
        boundTenant: currentExecutionScope()?.tenantSlug,
        threadContext: input.threadContext,
        text: input.text,
        scope: input.scope,
        workAuthority: input.workAuthority,
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
  approvalStoreRoots,
  createApprovalRequest,
  loadApprovalRequest,
} from '@agent/core/governance/approval-store';
import { buildVetoWindow } from '@agent/core/governance/approval-veto-window';
import { withExecutionContext } from '@agent/core/authority';
import { buildDecisionCard } from '@agent/core/governance/decision-card';
import { safeExistsSync, safeRmSync } from '@agent/core/secure-io';
import { resolveChannelModePolicy } from '@agent/core/surface/channel-mode-policy';
import { channelMemoryLogicalPath } from '@agent/core/surface/channel-memory-store';
import {
  collectSlackThreadContext,
  createSlackBotUserIdResolver,
  createSlackTypingHandle,
  ensureSlackApprovalAuthority,
  isSlackOwnerOnboardingActor,
  handleSlackTeamChannelCommand,
  resolveSlackApprovalText,
  runSlackChannelTurn,
  slackBotParticipatesInThread,
} from './index.js';

const TEAM_CHANNEL_MODES = JSON.stringify({
  slack: { 'C-team': { mode: 'team', tenant_slug: 'acme', approvers: ['U-lead'] } },
});

const THREAD_CONTEXT = 'Recent Slack thread context:\nUser (alice): 最初の相談';

function baseRequest() {
  return {
    text: 'それで、どうなりましたか',
    channel: 'C-thread',
    threadTs: '1700000000.000100',
    correlationId: 'slack-bridge-test',
    receivedAt: '1700000001.000200',
    actorId: 'U-operator',
  };
}

describe('slack bridge channel turn', () => {
  it('uses the shared script harness for direct startup and failure handling', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('satellites/slack-bridge/src/index.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain("from '@agent/core/script-harness'");
    expect(source).toContain("name: 'slack-bridge'");
    expect(source).toContain("['node', 'satellites/slack-bridge/src/index.ts', ...argv]");
    expect(source).not.toContain('_args: string[] = process.argv');
    expect(source).not.toContain('start().catch(');
  });

  it('renders approval authority through the shared user-facing vocabulary', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('satellites/slack-bridge/src/index.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('renderIntentAuthorityLabel(');
    expect(source).not.toContain('Authority: ${params.intentResolution.authority_level}');
    // SB-02: the journal append goes through the store writer, never a raw append.
    expect(source).toContain('appendStimulus(artifact.stimulus);');
    expect(source).not.toContain('stimuliJournalPath()');
    expect(source).not.toContain('const STIMULI_PATH =');
  });

  it('routes remaining automation and proposal replies through the locale catalog', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('satellites/slack-bridge/src/index.ts'), {
        encoding: 'utf8',
      })
    );
    for (const key of [
      'bridge:automation_registered',
      'bridge:automation_registered_cron',
      'bridge:automation_registration_failed',
      'bridge:mission_proposal_cancelled',
      'bridge:mission_proposal_expired',
      'bridge:mission_proposal_cancelled_by',
      'bridge:approval_ask_why',
    ]) {
      expect(source).toContain(key);
    }
    expect(source).not.toContain('スケジュール登録を実行できませんでした: ${detail}');
    expect(source).not.toContain(
      'ミッション提案をキャンセルしました。必要になったら、いつでも再提案できます。'
    );
  });

  it('excludes the current event from the collected thread context', async () => {
    const context = await collectSlackThreadContext(
      {
        conversations: {
          replies: async () => ({
            messages: [
              { ts: '1700000000.000100', text: '最初の相談', user: 'U-alice' },
              { ts: '1700000001.000200', text: 'それで、どうなりましたか', user: 'U-alice' },
            ],
          }),
        },
      },
      'C-thread',
      '1700000000.000100',
      '1700000001.000200'
    );

    expect(context).toContain(
      t('bridge:thread_user', { author: 'U-alice', text: '最初の相談' }, resolveOperatorLocale())
    );
    expect(context).not.toContain('それで、どうなりましたか');
  });

  it('forwards the collected thread context into the conversation', async () => {
    captured.conversationInputs.length = 0;
    const sent: string[] = [];
    const adapter: ChannelAdapter = {
      channel: 'slack',
      actorId: 'U-operator',
      threadContext: () => THREAD_CONTEXT,
      send: ({ text }) => {
        sent.push(text);
      },
    };

    const result = await runSlackChannelTurn(adapter, baseRequest());

    expect(captured.conversationInputs).toHaveLength(1);
    expect(captured.conversationInputs[0].threadContext).toBe(THREAD_CONTEXT);
    expect(result.text).toBe('ok');
    expect(sent).toEqual(['ok']);
  });

  it('runs the post-turn envelope callback before the typing reaction clears', async () => {
    captured.conversationInputs.length = 0;
    const calls: string[] = [];
    const adapter: ChannelAdapter = {
      channel: 'slack',
      actorId: 'U-operator',
      typing: () => ({
        stop: () => {
          calls.push('typing:stop');
        },
      }),
      shouldSend: () => false,
      send: () => {
        calls.push('send');
      },
    };

    await runSlackChannelTurn(adapter, baseRequest(), {
      afterTurn: () => {
        calls.push('afterTurn');
      },
    });

    expect(calls).toEqual(['afterTurn', 'typing:stop']);
  });

  it('adds and removes the Slack typing reaction through one lifecycle handle', async () => {
    const calls: string[] = [];
    const handle = await createSlackTypingHandle(
      {
        reactions: {
          add: async (input) => {
            calls.push(`add:${input.name}`);
          },
          remove: async (input) => {
            calls.push(`remove:${input.name}`);
          },
        },
      },
      'C-thread',
      '1700000001.000200'
    );

    await handle.stop();
    await handle.stop();

    expect(calls).toEqual(['add:eyes', 'remove:eyes']);
  });

  it('does not remove a reaction when Slack could not add it', async () => {
    const calls: string[] = [];
    const handle = await createSlackTypingHandle(
      {
        reactions: {
          add: async () => {
            calls.push('add');
            throw new Error('missing reaction scope');
          },
          remove: async () => {
            calls.push('remove');
          },
        },
      },
      'C-thread',
      '1700000001.000200'
    );

    await handle.stop();

    expect(calls).toEqual(['add']);
  });

  it('does not start provider typing when thread context resolution fails', async () => {
    const calls: string[] = [];
    const adapter: ChannelAdapter = {
      channel: 'slack',
      actorId: 'U-operator',
      threadContext: async () => {
        calls.push('thread-context');
        throw new Error('history unavailable');
      },
      typing: () => {
        calls.push('typing');
        return {
          stop: () => {
            calls.push('typing:stop');
          },
        };
      },
      send: () => {
        calls.push('send');
      },
    };

    await expect(runSlackChannelTurn(adapter, baseRequest())).rejects.toThrow(
      'history unavailable'
    );
    expect(calls).toEqual(['thread-context']);
  });
});

describe('slack approval text replies', () => {
  afterEach(() => {
    withExecutionContext('mission_controller', () => {
      for (const root of Object.values(approvalStoreRoots())) {
        const dir = pathResolver.rootResolve(`${root}/autonomy`);
        if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('lets the operator object to an autonomy card that arrived as plain text', () => {
    const record = createApprovalRequest('mission_controller', {
      channel: 'C-ops',
      storageChannel: 'autonomy',
      threadTs: '',
      correlationId: 'slack-veto-test',
      requestedBy: 'agent:test',
      draft: { title: 'Merge PR 42', summary: 'Merge PR 42 into main?' },
      decisionCard: buildDecisionCard({
        question: 'Merge PR 42 into main?',
        recommendation: 'Approve',
        riskTier: 'notify',
        level: 'veto',
        deliveredVia: { surface: 'slack', target: 'C-ops' },
      }),
      veto: buildVetoWindow({ windowMinutes: 120 }),
    });

    expect(
      resolveSlackApprovalText({
        channel: 'C-ops',
        threadTs: '1700000000.000100',
        text: 'hello there',
        actorId: 'U-operator',
      })
    ).toBeNull();

    const reply = resolveSlackApprovalText({
      channel: 'C-ops',
      threadTs: '1700000000.000100',
      text: '異議',
      actorId: 'U-operator',
    });
    expect(reply).toContain('Merge PR 42');
    expect(loadApprovalRequest('autonomy', record.id)).toMatchObject({
      status: 'rejected',
      decidedByType: 'human',
    });
  });
});

describe('slack team channel', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    withExecutionContext('mission_controller', () => {
      for (const root of Object.values(approvalStoreRoots())) {
        const dir = pathResolver.rootResolve(`${root}/autonomy`);
        if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('runs team turns with the tenant scope and the disclosure directive', async () => {
    vi.stubEnv('KYBERION_SURFACE_CHANNEL_MODES', TEAM_CHANNEL_MODES);
    captured.conversationInputs.length = 0;
    const adapter: ChannelAdapter = {
      channel: 'slack',
      actorId: 'U-member',
      threadContext: () => THREAD_CONTEXT,
      send: () => undefined,
    };

    await runSlackChannelTurn(adapter, {
      ...baseRequest(),
      channel: 'C-team',
      channelPolicy: resolveChannelModePolicy('slack', 'C-team'),
    });

    const input = captured.conversationInputs[0];
    expect(input.scope).toEqual({ tier: 'confidential', tenant_slug: 'acme' });
    // Team Channel E: isolated to the tenant, with reads bound to it.
    expect(input.isolation).toEqual({ tenantSlug: 'acme', maxTier: 'confidential' });
    expect(input.boundTenant).toBe('acme');
    expect(input.threadContext?.startsWith('[channel-policy]')).toBe(true);
    expect(input.threadContext).toContain(THREAD_CONTEXT);
  });

  it('runs ask-only speakers with workAuthority ask_only', async () => {
    vi.stubEnv('KYBERION_SURFACE_CHANNEL_MODES', TEAM_CHANNEL_MODES);
    const channelPolicy = resolveChannelModePolicy('slack', 'C-team');
    const adapter: ChannelAdapter = { channel: 'slack', actorId: 'U-x', send: () => undefined };
    const speaker = (role?: 'viewer' | 'operator') => ({
      surface: 'slack',
      actorId: 'U-x',
      denied: false,
      tenantSlug: 'acme',
      tierAccess: ['public' as const, 'confidential' as const],
      ...(role ? { role, principalId: 'user:x', memberId: 'x' } : {}),
      capabilities:
        role === 'operator'
          ? (['ask', 'request_work'] as const).slice()
          : (['ask'] as const).slice(),
    });

    captured.conversationInputs.length = 0;
    await runSlackChannelTurn(adapter, {
      ...baseRequest(),
      channel: 'C-team',
      channelPolicy,
      channelSpeaker: speaker('viewer'),
    });
    expect(captured.conversationInputs[0].workAuthority).toBe('ask_only');
    expect(captured.conversationInputs[0].threadContext).toContain("role 'viewer'");

    captured.conversationInputs.length = 0;
    await runSlackChannelTurn(adapter, {
      ...baseRequest(),
      channel: 'C-team',
      channelPolicy,
      channelSpeaker: speaker('operator'),
    });
    expect(captured.conversationInputs[0].workAuthority).toBeUndefined();
  });

  it('keeps owner_direct turns unscoped and without a directive', async () => {
    captured.conversationInputs.length = 0;
    await runSlackChannelTurn(
      {
        channel: 'slack',
        actorId: 'U-operator',
        threadContext: () => THREAD_CONTEXT,
        send: () => undefined,
      },
      { ...baseRequest(), channelPolicy: resolveChannelModePolicy('slack', 'C-thread') }
    );
    expect(captured.conversationInputs[0].scope).toBeUndefined();
    expect(captured.conversationInputs[0].isolation).toBeUndefined();
    expect(captured.conversationInputs[0].threadContext).toBe(THREAD_CONTEXT);
  });

  it('detects bot participation from the thread replies', async () => {
    const client = {
      conversations: {
        replies: vi.fn(async () => ({ messages: [{ user: 'U-member' }, { user: 'U-bot' }] })),
      },
    };
    await expect(slackBotParticipatesInThread(client, 'C-team', '1.0', 'U-bot')).resolves.toBe(
      true
    );
    await expect(slackBotParticipatesInThread(client, 'C-team', '1.0', 'U-other')).resolves.toBe(
      false
    );
    await expect(slackBotParticipatesInThread(client, 'C-team', '1.0', undefined)).resolves.toBe(
      false
    );
    const failing = {
      conversations: { replies: vi.fn(async () => Promise.reject(new Error('x'))) },
    };
    await expect(slackBotParticipatesInThread(failing, 'C-team', '1.0', 'U-bot')).resolves.toBe(
      false
    );
  });

  it('resolves the bot user id once and retries after a failure', async () => {
    const test = vi
      .fn<() => Promise<{ user_id?: string }>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ user_id: 'U-bot' });
    const resolve = createSlackBotUserIdResolver({ auth: { test } });
    await expect(resolve()).resolves.toBeUndefined();
    await expect(resolve()).resolves.toBe('U-bot');
    await expect(resolve()).resolves.toBe('U-bot');
    expect(test).toHaveBeenCalledTimes(2);
  });

  it('refuses approval-class actions from non-approvers in team channels', async () => {
    vi.stubEnv('KYBERION_SURFACE_CHANNEL_MODES', TEAM_CHANNEL_MODES);
    const postEphemeral = vi.fn(async () => ({}));
    const client = { chat: { postEphemeral } };
    await expect(ensureSlackApprovalAuthority(client, 'C-team', '1.0', 'U-member')).resolves.toBe(
      null
    );
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C-team', user: 'U-member' })
    );
    await expect(ensureSlackApprovalAuthority(client, 'C-team', '1.0', 'U-lead')).resolves.toBe(
      'U-lead'
    );
    await expect(ensureSlackApprovalAuthority(client, 'C-dm', '1.0', 'U-member')).resolves.toBe(
      'U-member'
    );
    expect(postEphemeral).toHaveBeenCalledTimes(1);
  });

  it('accepts onboarding actions only in owner_direct channels', () => {
    vi.stubEnv('KYBERION_SURFACE_CHANNEL_MODES', TEAM_CHANNEL_MODES);
    vi.stubEnv('KYBERION_SURFACE_ALLOWLISTS', JSON.stringify({ slack: ['U-lead', 'U-owner'] }));
    expect(isSlackOwnerOnboardingActor('C-team', 'U-lead')).toBe(false);
    expect(isSlackOwnerOnboardingActor('C-dm', 'U-owner')).toBe(true);
    expect(isSlackOwnerOnboardingActor('C-dm', 'U-stranger')).toBe(false);
  });

  it('refuses a text approval from a team member who is not an approver', () => {
    vi.stubEnv('KYBERION_SURFACE_CHANNEL_MODES', TEAM_CHANNEL_MODES);
    const record = createApprovalRequest('mission_controller', {
      channel: 'C-team',
      storageChannel: 'autonomy',
      threadTs: '',
      correlationId: 'slack-team-veto-test',
      requestedBy: 'agent:test',
      draft: { title: 'Merge PR 43', summary: 'Merge PR 43 into main?' },
      decisionCard: buildDecisionCard({
        question: 'Merge PR 43 into main?',
        recommendation: 'Approve',
        riskTier: 'notify',
        level: 'veto',
        deliveredVia: { surface: 'slack', target: 'C-team' },
      }),
      veto: buildVetoWindow({ windowMinutes: 120 }),
    });
    const channelPolicy = resolveChannelModePolicy('slack', 'C-team');

    const refused = resolveSlackApprovalText({
      channel: 'C-team',
      threadTs: '1700000000.000100',
      text: '異議',
      actorId: 'U-member',
      channelPolicy,
    });
    expect(refused).toBe(t('bridge:approval_not_authorized', undefined, resolveOperatorLocale()));
    expect(loadApprovalRequest('autonomy', record.id)).toMatchObject({ status: 'pending' });

    resolveSlackApprovalText({
      channel: 'C-team',
      threadTs: '1700000000.000100',
      text: '異議',
      actorId: 'U-lead',
      channelPolicy,
    });
    expect(loadApprovalRequest('autonomy', record.id)).toMatchObject({
      status: 'rejected',
      decidedBy: 'U-lead',
    });
  });
});

describe('slack team channel commands (P2)', () => {
  const channel = `C-p2-${Date.now().toString(36)}`;
  afterEach(() => {
    vi.unstubAllEnvs();
    withExecutionContext('mission_controller', () => {
      const file = pathResolver.rootResolve(
        channelMemoryLogicalPath({ surface: 'slack', tenantSlug: 'acme', channel })
      );
      if (safeExistsSync(file)) safeRmSync(file, { force: true });
    });
  });

  function speaker(role?: 'viewer' | 'operator' | 'approver') {
    const capabilities =
      role === 'operator'
        ? ['ask', 'request_work']
        : role === 'approver'
          ? ['ask', 'decide']
          : ['ask'];
    return {
      surface: 'slack',
      actorId: `U-${role ?? 'guest'}`,
      denied: false,
      tenantSlug: 'acme',
      tierAccess: ['public' as const, 'confidential' as const],
      ...(role ? { role, principalId: `user:${role}`, memberId: role } : {}),
      capabilities: capabilities as Array<'ask' | 'request_work' | 'decide'>,
    };
  }

  it('saves, lists and forgets channel memory by role and injects it into turns', async () => {
    vi.stubEnv(
      'KYBERION_SURFACE_CHANNEL_MODES',
      JSON.stringify({ slack: { [channel]: { mode: 'team', tenant_slug: 'acme' } } })
    );
    const policy = resolveChannelModePolicy('slack', channel);
    const run = (text: string, role?: 'viewer' | 'operator' | 'approver') =>
      handleSlackTeamChannelCommand({ policy, speaker: speaker(role), threadTs: '1.0', text });

    const locale = resolveOperatorLocale();
    expect(run('remember: standup is at 9:30', 'viewer')).toBe(
      t('bridge:channel_memory_not_authorized', undefined, locale)
    );
    const saved = run('remember: standup is at 9:30', 'operator');
    const id = saved?.match(/m[a-f0-9]{8}/)?.[0];
    expect(id).toBeTruthy();
    expect(run('memory', 'viewer')).toContain('standup is at 9:30');

    captured.conversationInputs.length = 0;
    await runSlackChannelTurn(
      { channel: 'slack', actorId: 'U-x', send: () => undefined },
      { ...baseRequest(), channel, channelPolicy: policy }
    );
    expect(captured.conversationInputs[0].threadContext).toContain('[channel-memory]');
    expect(captured.conversationInputs[0].threadContext).toContain('standup is at 9:30');

    expect(run(`forget ${id}`, 'operator')).toBe(
      t('bridge:channel_memory_not_authorized', undefined, locale)
    );
    expect(run(`forget ${id}`, 'approver')).toBe(
      t('bridge:channel_memory_forgotten', { id: String(id) }, locale)
    );
    expect(run('memory', 'viewer')).toBe(t('bridge:channel_memory_empty', undefined, locale));
  });

  it('escapes member text, honours the approvers fallback and hides other-tier facts', () => {
    vi.stubEnv(
      'KYBERION_SURFACE_CHANNEL_MODES',
      JSON.stringify({
        slack: { [channel]: { mode: 'team', tenant_slug: 'acme', approvers: ['U-guest'] } },
      })
    );
    const policy = resolveChannelModePolicy('slack', channel);
    const locale = resolveOperatorLocale();
    const saved = handleSlackTeamChannelCommand({
      policy,
      speaker: speaker('operator'),
      threadTs: '1.0',
      text: 'remember: ping <!channel> & <@U1>',
    });
    const id = String(saved?.match(/m[a-f0-9]{8}/)?.[0]);
    const listed = handleSlackTeamChannelCommand({
      policy,
      speaker: speaker(),
      threadTs: '1.0',
      text: 'memory',
    });
    expect(listed).toContain('&lt;!channel&gt; &amp; &lt;@U1&gt;');
    expect(listed).not.toContain('<!channel>');

    const denied = { ...speaker('operator'), denied: true };
    expect(
      handleSlackTeamChannelCommand({
        policy,
        speaker: denied,
        threadTs: '1.0',
        text: 'remember: x',
      })
    ).toBe(t('bridge:channel_memory_not_authorized', undefined, locale));

    // Unlinked actor on the channel approvers list may forget (same rule as approvals).
    expect(
      handleSlackTeamChannelCommand({
        policy,
        speaker: { ...speaker(), actorId: 'U-other' },
        threadTs: '1.0',
        text: `forget ${id}`,
      })
    ).toBe(t('bridge:channel_memory_not_authorized', undefined, locale));
    const guestApprover = { ...speaker(), actorId: 'U-guest' };
    expect(
      handleSlackTeamChannelCommand({
        policy: { ...policy, maxTier: 'public' },
        speaker: guestApprover,
        threadTs: '1.0',
        text: `forget ${id}`,
      })
    ).toBe(t('bridge:channel_memory_not_found', { id }, locale));
    expect(
      handleSlackTeamChannelCommand({
        policy,
        speaker: guestApprover,
        threadTs: '1.0',
        text: `forget ${id}`,
      })
    ).toBe(t('bridge:channel_memory_forgotten', { id }, locale));
  });

  it('answers thread status deterministically and ignores normal text', () => {
    vi.stubEnv(
      'KYBERION_SURFACE_CHANNEL_MODES',
      JSON.stringify({ slack: { [channel]: { mode: 'team', tenant_slug: 'acme' } } })
    );
    const policy = resolveChannelModePolicy('slack', channel);
    expect(handleSlackTeamChannelCommand({ policy, threadTs: '9.9', text: 'status?' })).toBe(
      t('bridge:thread_work_none', undefined, resolveOperatorLocale())
    );
    expect(
      handleSlackTeamChannelCommand({ policy, threadTs: '9.9', text: 'please summarise the doc' })
    ).toBeUndefined();
    expect(
      handleSlackTeamChannelCommand({
        policy: resolveChannelModePolicy('slack', 'C-dm'),
        threadTs: '9.9',
        text: 'status?',
      })
    ).toBeUndefined();
  });
});
