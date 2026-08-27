import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runChannelTurn, type IMessageStimulus, type SurfaceConversationResult } from '@agent/core';

const stubs = vi.hoisted(() => ({
  sent: [] as string[],
  historyFails: false,
}));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    resolveBlueBubblesConfig: () => undefined,
    getIMessageHistory: () => {
      if (stubs.historyFails) throw new Error('imessage store unavailable');
      return [];
    },
    sendIMessage: async (request: { text: string }) => {
      stubs.sent.push(request.text);
      return { ok: true };
    },
  };
});

import { buildIMessageChannelAdapter } from './index.js';

const MESSAGE: IMessageStimulus = {
  id: '42',
  chatId: 'chat-imsg-test',
  chatGuid: 'iMessage;-;chat-imsg-test',
  sender: '+15550000000',
  text: 'ちょっと相談があります',
  date: '2026-05-15T00:00:00.000Z',
  isFromMe: false,
};

const TURN_INPUT = {
  text: MESSAGE.text,
  channel: MESSAGE.chatId,
  threadTs: MESSAGE.id,
};

const REPLY: SurfaceConversationResult = {
  text: '',
  a2uiMessages: [],
  a2aMessages: [],
  delegationResults: [],
  approvalRequests: [],
};

beforeEach(() => {
  vi.useFakeTimers();
  stubs.sent.length = 0;
  stubs.historyFails = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('imessage bridge processing note', () => {
  it('never fires the processing note when the turn fails before typing starts', async () => {
    // M3g-ii: the note used to be armed before runChannelTurn and cancelled
    // only through the typing handle, so a buildThreadContext failure left it
    // armed and it posted "処理中です" for an already-failed turn.
    stubs.historyFails = true;
    const adapter = buildIMessageChannelAdapter(MESSAGE);

    await expect(runChannelTurn(adapter, TURN_INPUT, () => REPLY)).rejects.toThrow(
      'imessage store unavailable'
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(stubs.sent).toEqual([]);
  });

  it('arms the processing note inside typing.start and cancels it on stop', async () => {
    const adapter = buildIMessageChannelAdapter(MESSAGE);

    const handle = await adapter.typing?.(TURN_INPUT);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(stubs.sent).toEqual(['処理中です。少々お待ちください…']);

    stubs.sent.length = 0;
    const second = await adapter.typing?.(TURN_INPUT);
    await second?.stop();
    await handle?.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stubs.sent).toEqual([]);
  });
});
