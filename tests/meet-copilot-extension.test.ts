import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

type MessageListener = (message: any, sender: any, respond: (value: any) => void) => boolean;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    sockets.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

let sockets: FakeWebSocket[] = [];

async function createHarness() {
  sockets = [];
  let messageListener: MessageListener | undefined;
  const local: Record<string, any> = {};
  local.meetCopilotAuthToken = 'test-meet-extension-auth-token-012345678901234567890';
  const session: Record<string, any> = {};
  const tab = { id: 7, url: 'https://meet.google.com/abc-defg-hij' };
  const hooks = {
    tabs: [tab] as Array<Record<string, unknown>>,
    contentResponse: { ok: true } as any,
    relayed: [] as any[],
    panelNotices: [] as any[],
  };

  const chrome: any = {
    runtime: {
      onMessage: {
        addListener: (listener: MessageListener) => {
          messageListener = listener;
        },
      },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      sendMessage: vi.fn((message: any) => {
        hooks.panelNotices.push(message);
        return Promise.resolve(undefined);
      }),
      lastError: undefined,
    },
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => {
          const out: Record<string, any> = {};
          for (const key of keys) out[key] = local[key];
          return out;
        }),
        set: vi.fn((value: Record<string, any>, cb?: () => void) => {
          Object.assign(local, value);
          cb?.();
        }),
      },
      session: {
        get: vi.fn(async (keys: string[]) => {
          const out: Record<string, any> = {};
          for (const key of keys) out[key] = session[key];
          return out;
        }),
        set: vi.fn((value: Record<string, any>) => Object.assign(session, value)),
      },
    },
    tabs: {
      query: vi.fn(async () => hooks.tabs),
      create: vi.fn(async () => tab),
      get: vi.fn(async () => ({ ...tab, status: 'complete' })),
      sendMessage: vi.fn((_tabId: number, message: any, respond: (value: any) => void) => {
        hooks.relayed.push(message);
        respond(hooks.contentResponse);
      }),
    },
    scripting: { executeScript: vi.fn(async () => [{ result: true }]) },
  };
  (globalThis as any).chrome = chrome;
  (globalThis as any).WebSocket = FakeWebSocket;
  (
    globalThis as typeof globalThis & {
      __kyberionPiiScrub?: (value: unknown) => string;
    }
  ).__kyberionPiiScrub = (value: unknown) =>
    String(value ?? '')
      .replaceAll('SECRET', '[REDACTED:SECRET]')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED:EMAIL]');

  vi.resetModules();
  await import('../tools/meet-copilot-extension/background.js');
  if (!messageListener) throw new Error('Background message listener was not registered.');
  // connect() + restoreTranscript() resolve on the microtask queue.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const send = async (message: Record<string, unknown>) =>
    new Promise<any>((resolve) => {
      messageListener!(message, {}, resolve);
    });
  const openSocket = () => {
    const socket = sockets[sockets.length - 1];
    socket.readyState = FakeWebSocket.OPEN;
    return socket;
  };
  const caption = (text: string) =>
    send({ type: 'meet:event', payload: { event: 'caption', text, platform: 'meet' } });

  return { send, hooks, openSocket, caption };
}

describe('Meeting Copilot service worker', () => {
  it('buffers captions and serves them to a side panel that attaches mid-meeting', async () => {
    const harness = await createHarness();
    await harness.caption('予算の話をします');
    await harness.caption('来週決めます');

    const state = await harness.send({ type: 'panel:get-state' });

    expect(state.transcript.map((entry: any) => entry.text)).toEqual([
      '予算の話をします',
      '来週決めます',
    ]);
    expect(state.captions).toBe(2);
    expect(harness.hooks.panelNotices.filter((m) => m.type === 'panel:caption')).toHaveLength(2);
  });

  it('redacts PII before buffering or forwarding captions', async () => {
    const harness = await createHarness();
    await harness.caption('Contact taro@example.com about SECRET');

    const state = await harness.send({ type: 'panel:get-state' });
    expect(state.transcript[0].text).toBe('Contact [REDACTED:EMAIL] about [REDACTED:SECRET]');
    expect(JSON.stringify(harness.hooks.panelNotices)).not.toContain('taro@example.com');
  });

  it('ignores an empty caption instead of padding the transcript', async () => {
    const harness = await createHarness();
    await harness.caption('   ');

    const state = await harness.send({ type: 'panel:get-state' });
    expect(state.transcript).toEqual([]);
  });

  it('relays panel AI output to the driver as a typed ai_* event', async () => {
    const harness = await createHarness();
    const socket = harness.openSocket();
    await harness.caption('決定事項があります');

    const response = await harness.send({
      type: 'panel:ai-result',
      kind: 'summary',
      provider: 'chrome-summarizer',
      payload: { text: '要点', mode: 'full' },
    });

    expect(response).toMatchObject({ ok: true, event: 'ai_summary' });
    const relayed = JSON.parse(socket.sent[socket.sent.length - 1]);
    expect(relayed).toMatchObject({
      event: 'ai_summary',
      provider: 'chrome-summarizer',
      text: '要点',
      mode: 'full',
      transcript_lines: 1,
    });
  });

  it('does not let a panel payload override the event envelope', async () => {
    const harness = await createHarness();
    const socket = harness.openSocket();

    await harness.send({
      type: 'panel:ai-result',
      kind: 'summary',
      provider: 'chrome-prompt',
      payload: { event: 'join', cmd: 'leave', text: '要点' },
    });

    const relayed = JSON.parse(socket.sent[socket.sent.length - 1]);
    expect(relayed.event).toBe('ai_summary');
  });

  it('rejects an unknown AI result kind rather than forwarding it', async () => {
    const harness = await createHarness();
    const socket = harness.openSocket();

    const response = await harness.send({
      type: 'panel:ai-result',
      kind: 'exfiltrate',
      payload: { text: 'x' },
    });

    expect(response.ok).toBe(false);
    expect(socket.sent).toHaveLength(0);
  });

  it('reports a closed control channel instead of dropping AI output silently', async () => {
    const harness = await createHarness();

    const response = await harness.send({
      type: 'panel:ai-result',
      kind: 'insights',
      payload: { insights: {} },
    });

    expect(response).toMatchObject({ ok: false });
    expect(response.error).toContain('control channel');
  });

  it('posts an approved suggestion to the meeting chat through the content script', async () => {
    const harness = await createHarness();

    const response = await harness.send({ type: 'panel:send-chat', text: '予算感を伺えますか' });

    expect(response.ok).toBe(true);
    expect(harness.hooks.relayed).toContainEqual({
      type: 'meet:chat',
      text: '予算感を伺えますか',
    });
  });

  it('refuses to post an empty chat message', async () => {
    const harness = await createHarness();

    const response = await harness.send({ type: 'panel:send-chat', text: '   ' });

    expect(response.ok).toBe(false);
    expect(harness.hooks.relayed).toHaveLength(0);
  });

  it('ignores malformed WebSocket control messages before dispatch', async () => {
    const harness = await createHarness();
    const socket = harness.openSocket();

    socket.onmessage?.({ data: JSON.stringify({ cmd: 'set_mic', on: 'yes' }) });
    socket.onmessage?.({ data: JSON.stringify({ cmd: 'unknown', control_token: 'x' }) });
    socket.onmessage?.({ data: JSON.stringify(['set_mic', true]) });
    socket.onmessage?.({ data: '{malformed' });
    await Promise.resolve();

    expect(harness.hooks.relayed).toHaveLength(0);
  });

  it('accepts a shape-valid WebSocket control message', async () => {
    const harness = await createHarness();
    const socket = harness.openSocket();
    const controlToken = 'test-control-token-012345678901234567890123456789';
    socket.onmessage?.({ data: JSON.stringify({ cmd: 'session', control_token: controlToken }) });
    socket.onmessage?.({
      data: JSON.stringify({
        cmd: 'set_mic',
        control_token: controlToken,
        on: true,
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.hooks.relayed).toContainEqual({ type: 'meet:set_mic', on: true });
  });
});

/**
 * The caption extractor lives inside content.js's IIFE (it must, it runs in the
 * page). Lift the pure part out of the source so these assertions run against
 * the code that actually ships rather than a copy that can drift.
 */
function loadCaptionExtractor(): () => (next: string) => string {
  const source = readFileSync(
    path.resolve(__dirname, '../tools/meet-copilot-extension/content.js'),
    'utf8'
  );
  const start = source.indexOf('function commonPrefixLength');
  const end = source.indexOf('// ASR commits');
  if (start < 0 || end < 0) throw new Error('caption extractor block not found in content.js');
  return new Function(
    'MAX_CAPTION_OVERLAP',
    `${source.slice(start, end)}; return createCaptionExtractor;`
  )(2000);
}

describe('Meeting Copilot caption extraction', () => {
  it('emits only finalized text when live ASR rewrites the tail of the block', () => {
    const extract = loadCaptionExtractor()();
    // The block re-renders whole each time and the last sentence is revised.
    const emitted = [
      extract('予算の話を'),
      extract('予算の話をしま'),
      extract('予算の話をします。次は'),
      extract('予算の話をします。次回の'),
      extract('予算の話をします。次回の日程を決めます。'),
    ].filter(Boolean);

    expect(emitted.join('')).toBe('予算の話をします。次回の');
    // Nothing is emitted twice.
    expect(new Set(emitted).size).toBe(emitted.length);
  });

  it('re-anchors instead of re-emitting when the block scrolls off the top', () => {
    const extract = loadCaptionExtractor()();
    const emitted = [
      extract('AAAAA BBBBB'),
      extract('AAAAA BBBBB CCCCC'),
      extract('AAAAA BBBBB CCCCC DDDDD'),
      // 'AAAAA ' has scrolled away; the block now starts mid-transcript.
      extract('BBBBB CCCCC DDDDD EEEEE'),
      extract('BBBBB CCCCC DDDDD EEEEE FFFFF'),
    ].filter(Boolean);

    // Every token appears exactly once across the whole run — no loss, no repeat.
    const joined = emitted.join(' ');
    for (const token of ['AAAAA', 'BBBBB', 'CCCCC', 'DDDDD', 'EEEEE']) {
      expect(joined.split(token).length - 1, `token ${token}`).toBe(1);
    }
  });

  it('ignores an unchanged block', () => {
    const extract = loadCaptionExtractor()();
    extract('同じ内容です');
    extract('同じ内容ですが続きます');
    expect(extract('同じ内容ですが続きます')).toBe('');
  });
});
