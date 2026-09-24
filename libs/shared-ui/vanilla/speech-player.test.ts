// PA-09: browser speech player — Web Audio, speechSynthesis and host modes
// driven by fakes (AudioContext, AudioBufferSourceNode, AnalyserNode,
// speechSynthesis, fetch, timers, rAF). No DOM, no network.
import { describe, expect, it, vi } from 'vitest';
import {
  KB_SPEECH_MODES,
  createSpeechPlayer,
  estimateSpeechMs,
  speechSynthesisSupported,
} from './speech-player.js';

type Handler = ((event?: unknown) => void) | null;

function createFakes(
  options: {
    noAudioContext?: boolean;
    suspended?: 'stays' | 'resumes';
    decodeFails?: boolean;
    noSpeechSynthesis?: boolean;
  } = {}
) {
  const contexts: FakeAudioContext[] = [];
  const sources: FakeSource[] = [];
  const analysers: FakeAnalyser[] = [];
  const utterances: FakeUtterance[] = [];
  const timeouts = new Map<number, { fn: () => void; at: number }>();
  const frames = new Map<number, (t: number) => void>();
  let clock = 0;
  let handle = 1;

  class FakeAnalyser {
    fftSize = 2048;
    connectedTo: unknown = null;
    disconnected = false;
    connect(target: unknown) {
      this.connectedTo = target;
    }
    disconnect() {
      this.disconnected = true;
    }
    getByteTimeDomainData(buffer: Uint8Array) {
      for (let i = 0; i < buffer.length; i += 1) buffer[i] = i % 2 ? 160 : 96;
    }
  }

  class FakeSource {
    buffer: unknown = null;
    onended: Handler = null;
    started = false;
    stopped = false;
    disconnected = false;
    connectedTo: unknown = null;
    connect(target: unknown) {
      this.connectedTo = target;
    }
    disconnect() {
      this.disconnected = true;
    }
    start() {
      this.started = true;
    }
    stop() {
      this.stopped = true;
    }
    fireEnded() {
      this.onended?.();
    }
  }

  class FakeAudioContext {
    state: 'running' | 'suspended' | 'closed' = options.suspended ? 'suspended' : 'running';
    destination = { kind: 'destination' };
    closed = false;
    decoded: ArrayBuffer[] = [];
    constructor() {
      contexts.push(this);
    }
    resume() {
      if (options.suspended === 'resumes') this.state = 'running';
      return Promise.resolve();
    }
    decodeAudioData(bytes: ArrayBuffer) {
      this.decoded.push(bytes);
      if (options.decodeFails) return Promise.reject(new Error('EncodingError'));
      return Promise.resolve({ duration: 1.5 });
    }
    createBufferSource() {
      const source = new FakeSource();
      sources.push(source);
      return source;
    }
    createAnalyser() {
      const analyser = new FakeAnalyser();
      analysers.push(analyser);
      return analyser;
    }
    close() {
      this.closed = true;
      this.state = 'closed';
      return Promise.resolve();
    }
  }

  class FakeUtterance {
    lang = '';
    rate = 1;
    onstart: Handler = null;
    onend: Handler = null;
    onerror: Handler = null;
    onboundary: Handler = null;
    constructor(readonly text: string) {
      utterances.push(this);
    }
  }

  const synth = {
    spoken: [] as FakeUtterance[],
    cancels: 0,
    speak(utterance: FakeUtterance) {
      synth.spoken.push(utterance);
    },
    cancel() {
      synth.cancels += 1;
    },
  };

  const win: Record<string, unknown> = { AbortController };
  if (!options.noAudioContext) win.AudioContext = FakeAudioContext;
  if (!options.noSpeechSynthesis) {
    win.speechSynthesis = synth;
    win.SpeechSynthesisUtterance = FakeUtterance;
  }

  const timers = {
    setTimeout: (fn: () => void, ms: number) => {
      const id = handle++;
      timeouts.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimeout: (id: unknown) => {
      timeouts.delete(id as number);
    },
  };
  const raf = (fn: (t: number) => void) => {
    const id = handle++;
    frames.set(id, fn);
    return id;
  };
  const caf = (id: unknown) => {
    frames.delete(id as number);
  };

  return {
    win,
    timers,
    raf,
    caf,
    contexts,
    sources,
    analysers,
    utterances,
    synth,
    /** Advance the manual clock, firing due timeouts. */
    advance(ms: number) {
      clock += ms;
      for (const [id, entry] of [...timeouts]) {
        if (entry.at <= clock) {
          timeouts.delete(id);
          entry.fn();
        }
      }
    },
    frame() {
      for (const [id, fn] of [...frames]) {
        frames.delete(id);
        fn(clock);
      }
    },
    pendingFrames: () => frames.size,
    pendingTimeouts: () => timeouts.size,
  };
}

function createLipsyncSpy() {
  return {
    attachAnalyser: vi.fn(),
    detachAnalyser: vi.fn(),
    startSynthetic: vi.fn(),
    stopSynthetic: vi.fn(),
    pulse: vi.fn(),
  };
}

const WAV = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69, 1, 2, 3, 4]);

function audioResponse() {
  return new Response(WAV, {
    status: 200,
    headers: { 'content-type': 'audio/wav', 'x-kyberion-speech-engine': 'native_say' },
  });
}

/** Wait until pending promise continuations settle. */
async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function setup(
  fakeOptions: Parameters<typeof createFakes>[0] = {},
  fetchImpl: (...args: unknown[]) => Promise<Response> = async () => audioResponse()
) {
  const fakes = createFakes(fakeOptions);
  const lipsync = createLipsyncSpy();
  const states: Array<[string, string | null]> = [];
  const levels: number[] = [];
  const fetchSpy = vi.fn(fetchImpl);
  const player = createSpeechPlayer({
    win: fakes.win,
    synthesizeUrl: '/api/voice/synthesize',
    fetchImpl: fetchSpy as never,
    onState: (state, detail) => states.push([state, detail.mode]),
    onLevel: (level) => levels.push(level),
    lipsync,
    lang: 'ja-JP',
    raf: fakes.raf,
    caf: fakes.caf,
    timers: fakes.timers,
  });
  return { fakes, lipsync, states, levels, fetchSpy, player };
}

describe('speech-player helpers', () => {
  it('exposes the modes and a CJK-aware bound estimate', () => {
    expect(KB_SPEECH_MODES).toEqual(['browser-audio', 'speech-synthesis', 'host', 'none']);
    expect(estimateSpeechMs('')).toBe(0);
    expect(estimateSpeechMs('hi')).toBe(1200);
    expect(estimateSpeechMs('こんにちは、今日はいい天気ですね')).toBe(15 * 150);
    expect(speechSynthesisSupported({})).toBe(false);
  });
});

describe('browser-audio mode', () => {
  it('plays synthesized audio through an analyser and drives the lip-sync', async () => {
    const { fakes, lipsync, states, levels, fetchSpy, player } = setup();

    const done = player.speak('こんにちは');
    await flush(20);

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/voice/synthesize',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'こんにちは', language: 'ja-JP' }),
        cache: 'no-store',
      })
    );
    const [source] = fakes.sources;
    const [analyser] = fakes.analysers;
    expect(source.started).toBe(true);
    expect(source.connectedTo).toBe(analyser);
    expect(analyser.connectedTo).toBe(fakes.contexts[0].destination);
    expect(lipsync.attachAnalyser).toHaveBeenCalledWith(analyser);
    expect(player.state).toBe('speaking');
    expect(player.mode).toBe('browser-audio');

    fakes.frame();
    expect(levels.at(-1)).toBeGreaterThan(0);

    source.fireEnded();
    expect(await done).toEqual({
      mode: 'browser-audio',
      ok: true,
      durationMs: 1500,
      engineId: 'native_say',
    });
    expect(lipsync.detachAnalyser).toHaveBeenCalled();
    expect(source.disconnected).toBe(true);
    expect(analyser.disconnected).toBe(true);
    expect(levels.at(-1)).toBe(0);
    expect(fakes.pendingFrames()).toBe(0);
    expect(fakes.pendingTimeouts()).toBe(0);
    expect(states).toEqual([
      ['loading', 'browser-audio'],
      ['speaking', 'browser-audio'],
      ['idle', 'browser-audio'],
    ]);
    // speechSynthesis was never touched on the primary path.
    expect(fakes.synth.spoken).toHaveLength(0);
  });

  it('forces the end when onended never fires (bounded by the decoded duration)', async () => {
    const { fakes, player } = setup();
    const done = player.speak('hello');
    await flush(20);
    fakes.advance(1500 + 2000);
    expect((await done).ok).toBe(true);
    expect(fakes.sources[0].disconnected).toBe(true);
  });

  it('cancels an overlapping speak cleanly (generation token)', async () => {
    let releaseFirst: (r: Response) => void = () => undefined;
    let call = 0;
    const { fakes, player, lipsync } = setup({}, () => {
      call += 1;
      if (call === 1) return new Promise<Response>((resolve) => (releaseFirst = resolve));
      return Promise.resolve(audioResponse());
    });

    const first = player.speak('first');
    await flush();
    const second = player.speak('second');
    expect(await first).toEqual({ mode: 'browser-audio', ok: false, cancelled: true });
    releaseFirst(audioResponse());
    await flush(20);

    // Only the second utterance ever reached Web Audio.
    expect(fakes.sources).toHaveLength(1);
    expect(lipsync.attachAnalyser).toHaveBeenCalledTimes(1);
    fakes.sources[0].fireEnded();
    expect((await second).ok).toBe(true);
  });

  it('stop() during playback stops and releases the nodes', async () => {
    const { fakes, player, lipsync, states } = setup();
    const done = player.speak('hello');
    await flush(20);
    player.stop();
    expect(await done).toMatchObject({ mode: 'browser-audio', ok: false, cancelled: true });
    expect(fakes.sources[0].stopped).toBe(true);
    expect(fakes.sources[0].disconnected).toBe(true);
    expect(lipsync.detachAnalyser).toHaveBeenCalled();
    expect(states.at(-1)).toEqual(['idle', null]);
  });

  it('dispose() closes the AudioContext and refuses later speech', async () => {
    const { fakes, player } = setup();
    const done = player.speak('hello');
    await flush(20);
    player.dispose();
    expect((await done).cancelled).toBe(true);
    await flush();
    expect(fakes.contexts[0].closed).toBe(true);
    expect(await player.speak('again')).toEqual({ mode: 'none', ok: false, reason: 'disposed' });
  });

  it('resumes a suspended context via unlock()', async () => {
    const { fakes, player } = setup({ suspended: 'resumes' });
    expect(await player.unlock()).toBe(true);
    expect(fakes.contexts[0].state).toBe('running');
  });
});

describe('speech-synthesis fallback', () => {
  async function speakWithFallback(
    fakeOptions: Parameters<typeof createFakes>[0],
    fetchImpl?: (...args: unknown[]) => Promise<Response>
  ) {
    const ctx = setup(fakeOptions, fetchImpl);
    const done = ctx.player.speak('hello there');
    await flush(20);
    return { ...ctx, done };
  }

  it.each([
    [
      'voice-hub 501',
      {},
      async () => Response.json({ ok: false, error: 'synthesis_unsupported' }, { status: 501 }),
      'synthesis_http_501',
    ],
    [
      'network failure',
      {},
      async () => {
        throw new TypeError('fetch failed');
      },
      'synthesis_network',
    ],
    ['decode failure', { decodeFails: true }, undefined, 'decode_failed'],
    ['no AudioContext', { noAudioContext: true }, undefined, 'no_audio_context'],
    [
      'suspended AudioContext (no user gesture)',
      { suspended: 'stays' as const },
      undefined,
      'audio_context_suspended',
    ],
  ])('falls back on %s', async (_label, fakeOptions, fetchImpl, reason) => {
    const { fakes, lipsync, done, states } = await speakWithFallback(fakeOptions, fetchImpl);

    expect(fakes.synth.spoken).toHaveLength(1);
    const [utterance] = fakes.synth.spoken;
    expect(utterance.text).toBe('hello there');
    expect(utterance.lang).toBe('ja-JP');
    expect(fakes.sources).toHaveLength(0);

    utterance.onstart?.();
    expect(lipsync.startSynthetic).toHaveBeenCalledTimes(1);
    utterance.onboundary?.();
    utterance.onboundary?.();
    expect(lipsync.pulse).toHaveBeenCalledTimes(2);
    utterance.onend?.();

    expect(await done).toEqual({ mode: 'speech-synthesis', ok: true, fallbackReason: reason });
    expect(lipsync.stopSynthetic).toHaveBeenCalledTimes(1);
    expect(states.at(-2)).toEqual(['speaking', 'speech-synthesis']);
    expect(states.at(-1)).toEqual(['idle', 'speech-synthesis']);
  });

  it("skips the server with via: 'speech-synthesis'", async () => {
    const { fakes, player, fetchSpy } = setup();
    const done = player.speak('hi', { via: 'speech-synthesis', lang: 'en-US', rate: 1.1 });
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    const [utterance] = fakes.synth.spoken;
    expect(utterance.lang).toBe('en-US');
    expect(utterance.rate).toBe(1.1);
    utterance.onend?.();
    expect(await done).toEqual({ mode: 'speech-synthesis', ok: true });
  });

  it('reports none when neither path exists', async () => {
    const { player, states } = setup({ noAudioContext: true, noSpeechSynthesis: true }, async () =>
      audioResponse()
    );
    expect(await player.speak('hi')).toEqual({
      mode: 'none',
      ok: false,
      reason: 'no_speech_output',
      fallbackReason: 'no_audio_context',
    });
    // Nothing ever started, so no state transition was reported.
    expect(states).toEqual([]);
  });

  it('a new speak cancels the queued utterance and ignores its late events', async () => {
    const { fakes, player, lipsync } = setup({}, async () =>
      Response.json({ ok: false }, { status: 501 })
    );
    const first = player.speak('first');
    await flush(20);
    const [oldUtterance] = fakes.synth.spoken;
    const second = player.speak('second');
    expect((await first).cancelled).toBe(true);
    oldUtterance.onstart?.();
    expect(lipsync.startSynthetic).not.toHaveBeenCalled();
    await flush(20);
    fakes.synth.spoken[1].onend?.();
    expect((await second).ok).toBe(true);
  });

  it('bounds a speechSynthesis that never ends', async () => {
    const { fakes, player } = setup({}, async () => Response.json({}, { status: 501 }));
    const done = player.speak('hello');
    await flush(20);
    fakes.advance(estimateSpeechMs('hello') * 2 + 10000);
    expect(await done).toMatchObject({ ok: false, reason: 'speech_synthesis_timeout' });
  });
});

describe('host mode', () => {
  it('runs synthetic motion while the host speaks and stops on idle', () => {
    const { player, lipsync, states } = setup();
    expect(player.followHostSpeech({ speaking: true, estimatedMs: 2000 })).toEqual({
      mode: 'host',
      active: true,
      boundMs: 2000 * 1.25 + 1500,
    });
    // A repeated speaking update refreshes the bound without restarting motion.
    player.followHostSpeech({ speaking: true, estimatedMs: 2000 });
    expect(lipsync.startSynthetic).toHaveBeenCalledTimes(1);
    expect(player.mode).toBe('host');
    player.followHostSpeech({ speaking: false });
    expect(lipsync.stopSynthetic).toHaveBeenCalledTimes(1);
    expect(states).toEqual([
      ['speaking', 'host'],
      ['idle', 'host'],
    ]);
  });

  it('stops by itself when the idle update is lost', () => {
    const { fakes, player, lipsync } = setup();
    player.followHostSpeech({ speaking: true, estimatedMs: 1000 });
    fakes.advance(1000 * 1.25 + 1500);
    expect(lipsync.stopSynthetic).toHaveBeenCalledTimes(1);
    expect(player.state).toBe('idle');
  });

  it('uses a hard bound without an estimate', () => {
    const { player } = setup();
    expect(player.followHostSpeech({ speaking: true }).boundMs).toBe(120000);
  });
});
