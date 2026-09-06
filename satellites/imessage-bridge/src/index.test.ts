import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runChannelTurn } from '@agent/core/channel-adapter';
import { resolveOperatorLocale } from '@agent/core/operator-identity';
import { t } from '@agent/core/t';
import type { IMessageStimulus } from '@agent/core/imessage-utils';
import type { SurfaceConversationResult } from '@agent/core/channel-surface-types';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

const stubs = vi.hoisted(() => ({
  sent: [] as string[],
  historyFails: false,
  history: [] as IMessageStimulus[],
}));

vi.mock('@agent/core/bluebubbles-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/bluebubbles-adapter')>();
  return {
    ...actual,
    resolveBlueBubblesConfig: () => undefined,
  };
});

vi.mock('@agent/core/imessage-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/imessage-utils')>();
  return {
    ...actual,
    getIMessageHistory: () => {
      if (stubs.historyFails) throw new Error('imessage store unavailable');
      return stubs.history;
    },
  };
});

vi.mock('@agent/core/imessage-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/imessage-bridge')>();
  return {
    ...actual,
    sendIMessage: async (request: { text: string }) => {
      stubs.sent.push(request.text);
      return { ok: true };
    },
  };
});

import {
  buildIMessageChannelAdapter,
  parseIMessageBridgeInput,
  readIMessageHeader,
  resolveIMessageBridgeInputPath,
  resolveBlueBubblesWebhookSecret,
} from './index.js';

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
  stubs.history.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('imessage bridge processing note', () => {
  it('uses the shared exit-code convention instead of terminating the host process', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('satellites/imessage-bridge/src/index.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('process.exit(');
    expect(source).toContain(
      "import { defineScript, isDirectScript } from '@agent/core/script-harness'"
    );
    expect(source).toContain("name: 'imessage-bridge'");
    expect(source).toContain(
      "await main(['node', 'satellites/imessage-bridge/src/index.ts', ...argv])"
    );
    expect(source).not.toContain('main().catch(');
  });

  it('keeps file input inside the repository and limited to regular files', () => {
    expect(() => resolveIMessageBridgeInputPath('/tmp/imessage-input.json')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
    expect(() => resolveIMessageBridgeInputPath('scripts')).toThrow(
      'input must be an existing regular file'
    );
  });

  it('rejects non-object and non-string send input before dispatch', () => {
    expect(() => parseIMessageBridgeInput(null)).toThrow('request body must be a JSON object');
    expect(() => parseIMessageBridgeInput({ text: ['not-a-string'] })).toThrow(
      'text must be a string'
    );
    expect(() => parseIMessageBridgeInput({ attachments: ['ok', 42] })).toThrow(
      'attachments must be an array of strings'
    );
  });

  it('keeps webhook authentication headers scalar and preserves fallback precedence', () => {
    expect(readIMessageHeader(['unexpected'])).toBeUndefined();
    expect(readIMessageHeader({ value: 'unexpected' })).toBeUndefined();
    expect(readIMessageHeader('')).toBeUndefined();
    expect(readIMessageHeader('secret')).toBe('secret');

    expect(
      resolveBlueBubblesWebhookSecret({
        secret: 'direct-secret',
        authorization: 'Bearer bearer-secret',
      })
    ).toBe('direct-secret');
    expect(resolveBlueBubblesWebhookSecret({ authorization: 'Bearer bearer-secret' })).toBe(
      'bearer-secret'
    );
    expect(
      resolveBlueBubblesWebhookSecret({ authorization: 'Basic not-a-bearer' })
    ).toBeUndefined();
  });

  it('uses the shared safe JSON parser at Express input boundaries', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('satellites/imessage-bridge/src/index.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain("parseSafeJsonObjectValue(req.body, 'BlueBubbles webhook body')");
    expect(source).toContain("parseSafeJsonObjectValue(req.body ?? {}, 'iMessage request body')");
    expect(source).not.toContain("String(req.get('authorization') || '')");
  });

  it('preserves valid send input without coercing its fields', () => {
    expect(
      parseIMessageBridgeInput({
        action: 'send',
        recipient: 'chat-guid',
        text: 'hello',
        serviceName: 'bluebubbles',
        attachments: ['active/shared/tmp/file.png'],
      })
    ).toEqual({
      action: 'send',
      recipient: 'chat-guid',
      text: 'hello',
      serviceName: 'bluebubbles',
      attachments: ['active/shared/tmp/file.png'],
    });
  });

  it('passes only prior turns as thread context', async () => {
    stubs.history.push(
      {
        ...MESSAGE,
        id: '41',
        text: '前の相談',
        date: '2026-05-15T00:00:00.000Z',
      },
      MESSAGE
    );

    const context = await buildIMessageChannelAdapter(MESSAGE).threadContext?.(TURN_INPUT);

    const locale = resolveOperatorLocale();
    expect(context).toContain(t('bridge:thread_context', { channel: 'iMessage' }, locale));
    expect(context).toContain(
      t('bridge:thread_user', { author: '+15550000000', text: '前の相談' }, locale)
    );
    expect(context).not.toContain('ちょっと相談があります');
    expect(context).not.toContain('Current incoming message:');
  });

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
