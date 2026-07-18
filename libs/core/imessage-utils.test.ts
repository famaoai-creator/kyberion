import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(),
}));

vi.mock('./secure-io.js', () => ({
  safeExec: mocks.safeExec,
}));

import {
  buildIMessageDifferentialQuery,
  getRecentIMessages,
  formatIMessageAttachmentSummary,
  formatIMessageTapbackSummary,
  normalizeIMessageAttachments,
  normalizeIMessageTapback,
  shouldProcessIMessage,
} from './imessage-utils.js';

describe('imessage differential polling', () => {
  beforeEach(() => {
    mocks.safeExec.mockReset();
  });

  it('builds a bounded ROWID cursor query', () => {
    const query = buildIMessageDifferentialQuery(41, 20);
    expect(query).toContain('m.ROWID > 41');
    expect(query).toContain('ORDER BY m.ROWID ASC');
    expect(query).toContain('LIMIT 20');
    expect(query).toContain('chat_handle_join');
    expect(query).toContain('message_attachment_join');
    expect(query).toContain('associated_message_type');
    expect(query).toContain('associated_message_guid');
  });

  it('normalizes tapback reaction codes and keeps them out of model turns', () => {
    const tapback = normalizeIMessageTapback(2000, 'p:target-message');
    expect(tapback).toEqual({ kind: 'love', typeCode: 2000, targetGuid: 'p:target-message' });
    expect(formatIMessageTapbackSummary(tapback)).toBe(
      'Received iMessage tapback: love on p:target-message'
    );
    expect(shouldProcessIMessage({ text: '', isGroup: false, tapback })).toBe(false);
    expect(normalizeIMessageTapback(0)).toBeUndefined();
    expect(normalizeIMessageTapback(9999)).toMatchObject({ kind: 'unknown', typeCode: 9999 });
  });

  it('normalizes attachment payload variants without touching the file system', () => {
    expect(
      normalizeIMessageAttachments([
        { guid: 'a1', filename: '/tmp/photo.heic', mime_type: 'image/heic', uti: 'public.heic' },
        { id: 'a2', file_name: 'voice.m4a', content_type: 'audio/mp4', size: 42 },
      ])
    ).toEqual([
      {
        id: 'a1',
        filename: '/tmp/photo.heic',
        mimeType: 'image/heic',
        uti: 'public.heic',
        path: '/tmp/photo.heic',
      },
      { id: 'a2', filename: 'voice.m4a', mimeType: 'audio/mp4', size: 42 },
    ]);
    expect(
      formatIMessageAttachmentSummary([
        {
          id: 'a1',
          filename: '/Users/alice/Library/Messages/photo.heic',
          mimeType: 'image/heic',
          size: 42,
        },
      ])
    ).toContain('- photo.heic (image/heic, 42 bytes)');
  });

  it('keeps an absolute database attachment path available for governed transfer', () => {
    expect(
      normalizeIMessageAttachments('/Users/alice/Library/Messages/Attachments/photo.heic')
    ).toEqual([
      {
        id: 'attachment-/Users/alice/Library/Messages/Attachments/photo.heic',
        filename: '/Users/alice/Library/Messages/Attachments/photo.heic',
        path: '/Users/alice/Library/Messages/Attachments/photo.heic',
      },
    ]);
  });

  it('uses one sqlite subprocess for a differential tick', () => {
    mocks.safeExec.mockReturnValue(
      JSON.stringify([
        {
          id: 42,
          text: 'Kyberion 予定を確認して',
          created_at: '2026-07-18 05:00:00',
          is_from_me: 0,
          sender: 'alice@example.com',
          chat_identifier: 'chat-group-1',
          chat_guid: 'iMessage;+;chat-group-1',
          is_group: 1,
          attachment_summary: 'photo.heic\nimage/heic',
          associated_message_type: 2001,
          associated_message_guid: 'p:message-41',
        },
      ])
    );

    const messages = getRecentIMessages(41);

    expect(mocks.safeExec).toHaveBeenCalledTimes(1);
    expect(mocks.safeExec.mock.calls[0]?.[0]).toBe('sqlite3');
    expect(mocks.safeExec.mock.calls[0]?.[1]).toEqual(['-json', expect.any(String)]);
    expect(mocks.safeExec.mock.calls[0]?.[2]?.input).toContain('m.ROWID > 41');
    expect(messages).toEqual([
      expect.objectContaining({
        id: '42',
        chatId: 'chat-group-1',
        isGroup: true,
        attachments: [
          expect.objectContaining({ filename: 'photo.heic' }),
          expect.objectContaining({ filename: 'image/heic' }),
        ],
        tapback: { kind: 'like', typeCode: 2001, targetGuid: 'p:message-41' },
      }),
    ]);
  });

  it('falls back to imsg per-chat history when the database is unavailable', () => {
    mocks.safeExec.mockImplementation((command: string, args: string[]) => {
      if (command === 'sqlite3') throw new Error('sqlite unavailable');
      if (args[0] === 'chats') {
        return JSON.stringify({ id: 'chat-1', is_group: false });
      }
      return JSON.stringify({
        id: 7,
        text: 'fallback',
        created_at: '2026-07-18 05:00:00',
        is_from_me: false,
        chat_identifier: 'chat-1',
        chat_guid: 'guid-1',
        attachments: [{ id: 'a1', filename: 'fallback.pdf', mime_type: 'application/pdf' }],
      });
    });

    const messages = getRecentIMessages(0, 10);

    expect(mocks.safeExec.mock.calls.map(([command]) => command)).toEqual([
      'sqlite3',
      'imsg',
      'imsg',
    ]);
    expect(mocks.safeExec.mock.calls[2]?.[1]).toContain('--attachments');
    expect(messages[0]).toMatchObject({
      id: '7',
      chatId: 'chat-1',
      attachments: [
        expect.objectContaining({ filename: 'fallback.pdf', mimeType: 'application/pdf' }),
      ],
    });
  });
});
