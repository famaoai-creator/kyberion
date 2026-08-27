import { describe, expect, it } from 'vitest';
import {
  formatChannelTurnText,
  formatChannelThreadContext,
  runChannelTurn,
  type ChannelAdapter,
} from './channel-adapter.js';
import { isSurfaceAsyncChannel } from './channel-surface-types.js';

describe('SurfaceAsyncChannel registry', () => {
  it('accepts manifest channels and rejects unregistered values', () => {
    expect(isSurfaceAsyncChannel('slack')).toBe(true);
    expect(isSurfaceAsyncChannel('terminal')).toBe(true);
    expect(isSurfaceAsyncChannel('unknown-surface')).toBe(false);
  });
});

describe('formatChannelThreadContext', () => {
  it('normalizes recent provider messages while preserving speaker labels', () => {
    expect(
      formatChannelThreadContext('Slack', [
        { role: 'user', authorLabel: 'alice', text: 'Hello' },
        { role: 'assistant', authorLabel: 'bot', text: 'Hi there' },
      ])
    ).toBe('Recent Slack thread context:\nUser (alice): Hello\nAssistant: Hi there');
  });

  it('returns no context for empty or whitespace-only history', () => {
    expect(
      formatChannelThreadContext('Slack', [{ role: 'user', authorLabel: 'alice', text: '   ' }])
    ).toBeUndefined();
  });
});

describe('runChannelTurn', () => {
  it('does not append contract labels to autonomous replies', () => {
    expect(
      formatChannelTurnText({
        text: '了解しました。',
        a2uiMessages: [],
        a2aMessages: [],
        delegationResults: [],
        approvalRequests: [],
        intentResolution: {
          request_id: 'ir_auto',
          normalized_intent: 'answer_question',
          missing_inputs: [],
          resolution_shape: 'direct_answer',
          outcome_kind: 'answer',
          authority_level: 'autonomous',
          next_action: { kind: 'continue', label: 'continue', consequence: 'none' },
          rationale: 'autonomous',
        },
      })
    ).toBe('了解しました。');
  });

  it('can suppress contract labels for spoken delivery', () => {
    expect(
      formatChannelTurnText(
        {
          text: '承認待ちです。',
          a2uiMessages: [],
          a2aMessages: [],
          delegationResults: [],
          approvalRequests: [],
          intentResolution: {
            request_id: 'ir_voice',
            normalized_intent: 'send_message',
            missing_inputs: [],
            resolution_shape: 'task_session',
            outcome_kind: 'service_change',
            authority_level: 'approval_required',
            next_action: {
              kind: 'request_approval',
              label: '承認してください',
              consequence: '実行待ち',
            },
            rationale: 'approval',
          },
        },
        { includeContract: false }
      )
    ).toBe('承認待ちです。');
  });

  it('localizes contract labels to the spoken reply language', () => {
    const formatted = formatChannelTurnText({
      text: '承認が必要です。',
      a2uiMessages: [],
      a2aMessages: [],
      delegationResults: [],
      approvalRequests: [],
      intentResolution: {
        request_id: 'ir_ja',
        normalized_intent: 'send_message',
        missing_inputs: [],
        resolution_shape: 'task_session',
        outcome_kind: 'service_change',
        authority_level: 'approval_required',
        next_action: {
          kind: 'request_approval',
          label: '承認してください',
          consequence: '実行待ち',
        },
        rationale: 'approval',
      },
    });
    expect(formatted).toContain('理解: send_message');
    expect(formatted).not.toContain('Understanding:');
  });

  it('keeps thread context, typing, conversation, delivery, and cleanup ordered', async () => {
    const calls: string[] = [];
    const adapter: ChannelAdapter = {
      channel: 'telegram',
      actorId: 'operator-1',
      threadContext: () => {
        calls.push('thread');
        return 'previous';
      },
      typing: () => {
        calls.push('typing:start');
        return { stop: () => calls.push('typing:stop') };
      },
      send: (message) => calls.push(`send:${message.text}`),
    };
    const result = await runChannelTurn(
      adapter,
      { text: 'hello', channel: 'c', threadTs: 't' },
      (input) => {
        calls.push(`conversation:${input.threadContext}:${input.actorId}`);
        return {
          text: 'reply',
          a2uiMessages: [],
          a2aMessages: [],
          delegationResults: [],
          approvalRequests: [],
        };
      }
    );

    expect(result.text).toBe('reply');
    expect(calls).toEqual([
      'thread',
      'typing:start',
      'conversation:previous:operator-1',
      'send:reply',
      'typing:stop',
    ]);
  });

  it('stops typing even when conversation fails', async () => {
    const calls: string[] = [];
    await expect(
      runChannelTurn(
        {
          channel: 'discord',
          actorId: 'operator-1',
          typing: () => ({ stop: () => calls.push('stop') }),
          send: () => undefined,
        },
        { text: 'hello', channel: 'c', threadTs: 't' },
        () => Promise.reject(new Error('failed'))
      )
    ).rejects.toThrow('failed');
    expect(calls).toEqual(['stop']);
  });

  it('never starts typing when thread context resolution fails', async () => {
    // M3g-ii: iMessage arms its "処理中です" note inside typing.start, so a
    // thread-context failure must leave no armed timer behind.
    const calls: string[] = [];
    await expect(
      runChannelTurn(
        {
          channel: 'imessage',
          actorId: 'operator-1',
          threadContext: () => {
            throw new Error('history unavailable');
          },
          typing: () => {
            calls.push('typing:start');
            return { stop: () => calls.push('typing:stop') };
          },
          send: () => calls.push('send'),
        },
        { text: 'hello', channel: 'c', threadTs: 't' },
        () => {
          calls.push('conversation');
          return {
            text: 'reply',
            a2uiMessages: [],
            a2aMessages: [],
            delegationResults: [],
            approvalRequests: [],
          };
        }
      )
    ).rejects.toThrow('history unavailable');
    expect(calls).toEqual([]);
  });

  it('keeps typing alive until a bridge has posted its post-turn envelopes', async () => {
    // M3g-iii: shouldSend withholds delivery exactly on the proposal/approval
    // paths, so stopping typing before afterTurn would clear the indicator
    // while the operator-visible work is still pending.
    const calls: string[] = [];
    await runChannelTurn(
      {
        channel: 'slack',
        actorId: 'operator-1',
        typing: () => {
          calls.push('typing:start');
          return { stop: () => calls.push('typing:stop') };
        },
        shouldSend: ({ result }) => !result.missionProposals?.length,
        send: (message) => calls.push(`send:${message.text}`),
      },
      { text: 'make it a mission', channel: 'c', threadTs: 't' },
      () => ({
        text: 'proposal',
        a2uiMessages: [],
        a2aMessages: [],
        delegationResults: [],
        approvalRequests: [],
        missionProposals: [{ mission_id: 'm1' } as never],
      }),
      {
        afterTurn: (result) => {
          calls.push(`afterTurn:${result.text}`);
        },
      }
    );

    expect(calls).toEqual(['typing:start', 'afterTurn:proposal', 'typing:stop']);
  });

  it('stops typing when a post-turn envelope send fails', async () => {
    const calls: string[] = [];
    await expect(
      runChannelTurn(
        {
          channel: 'telegram',
          actorId: 'operator-1',
          typing: () => ({ stop: () => calls.push('typing:stop') }),
          send: () => calls.push('send'),
        },
        { text: 'hello', channel: 'c', threadTs: 't' },
        () => ({
          text: 'reply',
          a2uiMessages: [],
          a2aMessages: [],
          delegationResults: [],
          approvalRequests: [],
        }),
        {
          afterTurn: () => {
            throw new Error('envelope post failed');
          },
        }
      )
    ).rejects.toThrow('envelope post failed');
    expect(calls).toEqual(['send', 'typing:stop']);
  });

  it('lets a bridge defer delivery for proposal and approval envelopes', async () => {
    const sent: string[] = [];
    await runChannelTurn(
      {
        channel: 'slack',
        actorId: 'operator-1',
        shouldSend: ({ result }) => !result.missionProposals?.length,
        send: (message) => sent.push(message.text),
      },
      { text: 'make it a mission', channel: 'c', threadTs: 't' },
      () => ({
        text: 'proposal',
        a2uiMessages: [],
        a2aMessages: [],
        delegationResults: [],
        approvalRequests: [],
        missionProposals: [{ mission_id: 'm1' } as never],
      })
    );
    expect(sent).toEqual([]);
  });

  it('surfaces approval next action and consequence on text-only channels', async () => {
    const sent: string[] = [];
    const result = await runChannelTurn(
      {
        channel: 'slack',
        actorId: 'operator-1',
        send: (message) => sent.push(message.text),
      },
      { text: 'send it', channel: 'c', threadTs: 't' },
      () => ({
        text: 'The plan is ready.',
        a2uiMessages: [],
        a2aMessages: [],
        delegationResults: [],
        approvalRequests: [],
        intentResolution: {
          request_id: 'ir_12345678',
          normalized_intent: 'send_message',
          missing_inputs: [],
          resolution_shape: 'task_session',
          outcome_kind: 'service_change',
          authority_level: 'approval_required',
          next_action: {
            kind: 'request_approval',
            label: 'Approve this plan to continue.',
            consequence: 'The action waits for approval.',
          },
          rationale: 'approval is required',
        },
      })
    );

    expect(sent[0]).toContain('Understanding: send_message');
    expect(sent[0]).toContain('Missing input: none');
    expect(sent[0]).toContain('Next action: Approve this plan to continue.');
    expect(sent[0]).toContain('Consequence: The action waits for approval.');
    expect(sent[0]).toContain('Outcome: service_change');
    expect(result.text).toBe(sent[0]);
  });
});
