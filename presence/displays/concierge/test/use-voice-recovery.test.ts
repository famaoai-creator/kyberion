import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { installFakeDom } from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { useVoice, type UseVoiceResult } from '../src/lib/use-voice';
import type { VoiceListenOnceResponse } from '../src/lib/voice-types';

const player = vi.hoisted(() => ({
  setLipsync: vi.fn(),
  followHostSpeech: vi.fn(),
  stop: vi.fn(),
  dispose: vi.fn(),
  unlock: vi.fn(async () => true),
  setLang: vi.fn(),
  speak: vi.fn(),
}));
vi.mock('../../../../libs/shared-ui/vanilla/speech-player.js', () => ({
  createSpeechPlayer: () => player,
}));

let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
let unmount: (() => void) | undefined;
const poll = vi.fn((_callback: () => void, _interval: number) => 1);
const clearPoll = vi.fn();
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
function response(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}
const spokenReply = { ok: true, spoken: true, replyText: 'Already spoken by the server' };
function mountVoice() {
  let current!: UseVoiceResult;
  function Harness() {
    current = useVoice('en');
    return null;
  }
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  act(() => root.render(createElement(Harness)));
  unmount = () => act(() => root.unmount());
  return () => current;
}
function stubVoice(listen: () => Promise<Response>) {
  const fetch = vi.fn(async (url: string) => {
    if (url === '/api/voice/listen-once') return listen();
    if (url === '/api/voice/status')
      return response({ available: true, speech: { status: 'idle' } });
    throw new Error('Unexpected voice endpoint: ' + url);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
beforeAll(async () => {
  dom = installFakeDom({
    localStorage: { getItem: () => null, setItem: () => undefined },
    setInterval: poll,
    clearInterval: clearPoll,
  });
  client = await import('react-dom/client');
});
afterAll(() => dom.restore());
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  unmount?.();
  unmount = undefined;
  vi.unstubAllGlobals();
  delete dom.window.speechSynthesis;
});

describe('voice listen-once recovery', () => {
  it.each([
    { status: 401, body: '<html>Sign in</html>' },
    { status: 401, body: '' },
    { status: 403, body: '<html>Access denied</html>' },
    { status: 403, body: '' },
  ])(
    'classifies $status with body "$body" before attempting JSON parsing',
    async ({ status, body }) => {
      const denial = new Response(body, { status, headers: { 'content-type': 'text/html' } });
      const parse = vi.spyOn(denial, 'json');
      const fetch = stubVoice(async () => denial);
      const voice = mountVoice();
      await flush();
      expect(voice().tier).toBe(1);
      let result: VoiceListenOnceResponse | undefined;
      await act(async () => {
        result = await voice().listenOnce(() => true);
      });
      expect(result).toEqual({ ok: false, error: 'listen_failed_' + status });
      expect(parse).not.toHaveBeenCalled();
      expect(voice().listening).toBe(false);
      expect(voice().speaking).toBe(false);
      expect(poll).not.toHaveBeenCalled();
      expect(fetch.mock.calls.filter(([url]) => url === '/api/voice/listen-once')).toHaveLength(1);
    }
  );

  it.each(['network', 'body'] as const)(
    'suppresses speaking state and polling when verification expires during the %s wait',
    async (stage) => {
      const network = deferred<Response>();
      const body = deferred<unknown>();
      const received = response(spokenReply);
      if (stage === 'body') vi.spyOn(received, 'json').mockReturnValue(body.promise);
      const fetch = stubVoice(async () => (stage === 'network' ? network.promise : received));
      const voice = mountVoice();
      await flush();
      let current = true;
      let result!: Promise<VoiceListenOnceResponse>;
      act(() => {
        result = voice().listenOnce(() => current);
      });
      await flush();
      expect(voice().listening).toBe(true);
      current = false;
      await act(async () => {
        if (stage === 'network') network.resolve(received);
        else body.resolve(spokenReply);
        await result;
      });
      expect(await result).toEqual(spokenReply);
      expect(voice().listening).toBe(false);
      expect(voice().speaking).toBe(false);
      expect(voice().speechMode).toBeNull();
      expect(poll).not.toHaveBeenCalled();
      expect(fetch.mock.calls.filter(([url]) => url === '/api/voice/status')).toHaveLength(1);
    }
  );

  it.each([true, false])(
    'retains live speech mirroring with an explicit current guard: %s',
    async (useGuard) => {
      stubVoice(async () => response(spokenReply));
      const voice = mountVoice();
      await flush();
      await act(async () => {
        await voice().listenOnce(useGuard ? () => true : undefined);
      });
      expect(voice().listening).toBe(false);
      expect(voice().speaking).toBe(true);
      expect(voice().speechMode).toBe('host');
      expect(poll).toHaveBeenCalledTimes(1);
      expect(poll.mock.calls[0]).toHaveLength(2);
    }
  );
});

it('preserves a valid service-unavailable response that explains why listening could not start', async () => {
  const unavailable = {
    ok: false,
    error: 'no_input_device',
    reason: 'Select an input device before listening.',
  };
  const received = new Response(JSON.stringify(unavailable), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
  const parse = vi.spyOn(received, 'json');
  stubVoice(async () => received);
  const voice = mountVoice();
  await flush();
  let result: VoiceListenOnceResponse | undefined;
  await act(async () => {
    result = await voice().listenOnce(() => true);
  });
  expect(result).toEqual(unavailable);
  expect(parse).toHaveBeenCalledOnce();
  expect(voice().listening).toBe(false);
  expect(voice().speaking).toBe(false);
  expect(poll).not.toHaveBeenCalled();
});

it('resets active browser speech locally without issuing a voice-stop request', async () => {
  const cancel = vi.fn();
  const speak = vi.fn(
    (utterance: {
      onstart: (() => void) | null;
      onend?: (() => void) | null;
      onerror?: (() => void) | null;
    }) => utterance.onstart?.()
  );
  dom.window.speechSynthesis = { cancel, speak };
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      lang = '';
      rate = 1;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    }
  );
  const fetch = stubVoice(async () => response(spokenReply));
  const voice = mountVoice();
  await flush();
  act(() => voice().speakText('Current browser reply'));
  expect(voice().speaking).toBe(true);
  expect(voice().speechMode).toBe('speech-synthesis');
  const cancellations = cancel.mock.calls.length;
  act(() => voice().resetPlayback());
  expect(cancel).toHaveBeenCalledTimes(cancellations + 1);
  expect(voice().speaking).toBe(false);
  expect(voice().speechMode).toBeNull();
  const obsolete = speak.mock.calls[0][0];
  act(() => obsolete.onstart?.());
  expect(voice().speaking).toBe(false);
  act(() => voice().speakText('A newer verified reply'));
  expect(voice().speaking).toBe(true);
  act(() => {
    obsolete.onend?.();
    obsolete.onerror?.();
  });
  expect(voice().speaking).toBe(true);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/voice/status']);
});

it.each(['speaking', 'idle'] as const)(
  'ignores stale %s polling after a local playback reset',
  async (status) => {
    const pendingPoll = deferred<Response>();
    let reads = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url !== '/api/voice/status') throw new Error('Unexpected voice endpoint: ' + url);
      return ++reads === 1
        ? response({ available: true, speech: { status: 'idle' } })
        : pendingPoll.promise;
    });
    vi.stubGlobal('fetch', fetch);
    const voice = mountVoice();
    await flush();
    act(() => {
      voice().attachLipsync({} as NonNullable<Parameters<UseVoiceResult['attachLipsync']>[0]>);
      voice().notifyServerSpeech();
    });
    expect(voice().speaking).toBe(true);
    act(() => poll.mock.calls[0][0]());
    await flush();
    act(() => voice().resetPlayback());
    expect(player.stop).toHaveBeenCalledOnce();
    expect(clearPoll).toHaveBeenCalledOnce();
    expect(voice().speaking).toBe(false);
    expect(voice().speechMode).toBeNull();
    if (status === 'idle') act(() => voice().notifyServerSpeech());
    const priorMirrors = player.followHostSpeech.mock.calls.length;
    const priorClears = clearPoll.mock.calls.length;
    await act(async () =>
      pendingPoll.resolve(response({ available: true, speech: { status, estimated_ms: 1000 } }))
    );
    expect(player.followHostSpeech).toHaveBeenCalledTimes(priorMirrors);
    expect(clearPoll).toHaveBeenCalledTimes(priorClears);
    expect(voice().speaking).toBe(status === 'idle');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/voice/status',
      '/api/voice/status',
    ]);
  }
);
