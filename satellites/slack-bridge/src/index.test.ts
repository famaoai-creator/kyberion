import { describe, expect, it, vi } from 'vitest';
import type { ChannelAdapter } from '@agent/core/channel-adapter';
import { resolveOperatorLocale } from '@agent/core/operator-identity';
import { t } from '@agent/core/t';
import type {
  SurfaceConversationMessageInput,
  SurfaceConversationResult,
} from '@agent/core/channel-surface-types';
import { runSurfaceMessageConversation } from '@agent/core/channel-surface';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

vi.mock('@slack/bolt', () => ({
  App: class MockApp {},
  LogLevel: {},
}));

const captured = vi.hoisted(() => ({
  conversationInputs: [] as { threadContext?: string; text: string }[],
}));

vi.mock('@agent/core/channel-surface', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/channel-surface')>();
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
  collectSlackThreadContext,
  createSlackTypingHandle,
  runSlackChannelTurn,
} from './index.js';

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
    expect(source).toContain('appendJsonLine(stimuliJournalPath(), artifact.stimulus);');
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
