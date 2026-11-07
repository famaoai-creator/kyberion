import { describe, expect, it } from 'vitest';
import {
  buildIMessageReplyRequest,
  buildIMessageSendArgs,
  buildIMessageSendScript,
  deriveIMessageCliCapabilities,
  advanceIMessagePollCursor,
} from './imessage-bridge.js';
import {
  containsIMessageWakeWord,
  inferIMessageGroup,
  shouldProcessIMessage,
  stripLeadingIMessageWakeWord,
} from './imessage-utils.js';

describe('imessage bridge', () => {
  it('does not advance the polling cursor when processing fails', () => {
    expect(advanceIMessagePollCursor(41, 42, 'failed')).toBe(41);
    expect(advanceIMessagePollCursor(41, 42, 'processed')).toBe(42);
    expect(advanceIMessagePollCursor(42, 41, 'ignored')).toBe(42);
  });

  it('builds a safe Messages AppleScript send command (legacy fallback)', () => {
    const script = buildIMessageSendScript({
      recipient: 'alice@example.com',
      text: 'Hello "Kyberion"',
    });

    expect(script).toContain('tell application "Messages"');
    expect(script).toContain('send "Hello \\"Kyberion\\"" to buddy "alice@example.com"');
  });

  it('keeps group replies on the incoming chat instead of DMing the sender', () => {
    expect(
      buildIMessageReplyRequest(
        { sender: '+819012345678', chatId: 'chat-guid-group-1' },
        'グループへの返信'
      )
    ).toEqual({
      recipient: '',
      chatId: 'chat-guid-group-1',
      text: 'グループへの返信',
    });
  });

  it('falls back to the sender when no chat id is available', () => {
    expect(buildIMessageReplyRequest({ sender: 'alice@example.com' }, '返信')).toEqual({
      recipient: 'alice@example.com',
      text: '返信',
    });
  });

  it('builds a chat-target attachment send without duplicating text or changing the target', () => {
    expect(
      buildIMessageSendArgs({
        recipient: '',
        chatId: 'chat-guid-group-1',
        text: '添付します',
        attachments: ['/tmp/report.pdf', '/tmp/plot.png'],
      })
    ).toEqual([
      'send',
      '--chat-id',
      'chat-guid-group-1',
      '--text',
      '添付します',
      '--file',
      '/tmp/report.pdf',
      '--file',
      '/tmp/plot.png',
    ]);
  });

  it('allows attachment-only sends but rejects an empty payload', () => {
    expect(
      buildIMessageSendArgs({
        recipient: 'alice@example.com',
        text: '',
        attachments: ['/tmp/photo.heic'],
      })
    ).toEqual(['send', '--to', 'alice@example.com', '--file', '/tmp/photo.heic']);
    expect(() =>
      buildIMessageSendArgs({ recipient: 'alice@example.com', text: '', attachments: [] })
    ).toThrow('text or attachment is required');
    expect(() =>
      buildIMessageSendArgs({
        recipient: 'alice@example.com',
        text: '添付',
        attachments: 'not-an-array' as unknown as string[],
      })
    ).toThrow('attachments must be an array');
  });

  it('derives attachment and group capabilities from imsg help contracts', () => {
    expect(
      deriveIMessageCliCapabilities(
        'imsg send [--to] [--chat-id] [--text] [--file]',
        'imsg history [--chat-id] [--attachments] --json'
      )
    ).toEqual({
      send_text: true,
      send_attachments: true,
      receive_attachments: true,
      group_target: true,
    });
    expect(deriveIMessageCliCapabilities('', '')).toEqual({
      send_text: true,
      send_attachments: false,
      receive_attachments: false,
      group_target: false,
    });
  });

  it('infers group chats and gates messages without the wake word', () => {
    expect(inferIMessageGroup({ is_group: true })).toBe(true);
    expect(inferIMessageGroup({ participants: ['alice', 'bob'] })).toBe(true);
    expect(inferIMessageGroup({ is_group: false, participants: ['alice', 'bob'] })).toBe(false);
    expect(shouldProcessIMessage({ text: 'おはよう', isGroup: true }, 'Kyberion')).toBe(false);
    expect(shouldProcessIMessage({ text: 'Kyberion おはよう', isGroup: true }, 'Kyberion')).toBe(
      true
    );
    expect(shouldProcessIMessage({ text: 'おはよう', isGroup: false }, 'Kyberion')).toBe(true);
  });

  it('strips only a leading wake word before delegation', () => {
    expect(stripLeadingIMessageWakeWord(' Kyberion: 予定を確認して ', 'Kyberion')).toBe(
      '予定を確認して'
    );
    expect(containsIMessageWakeWord('本文に kyberion が出る', 'Kyberion')).toBe(true);
    expect(stripLeadingIMessageWakeWord('予定に Kyberion が出る', 'Kyberion')).toBe(
      '予定に Kyberion が出る'
    );
  });
});
