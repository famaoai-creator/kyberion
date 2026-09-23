import { describe, expect, it, vi } from 'vitest';

import {
  SPEECH_SYNTHESIZE_MAX_TEXT_CHARS,
  SpeechSynthesisUnsupportedError,
  buildNativeTtsFileCommand,
  createSpeechSynthesizeHandler,
  estimateSpokenDurationMs,
  normalizeSpeechSynthesisLanguage,
  parseWavInfo,
  readSpeechSynthesizeRequest,
  type SpeechSynthesizeDeps,
} from './speech-synthesis.js';

/** A PCM WAV with optional extra chunk before `data` (like macOS `say`'s FLLR). */
function buildWav(options: {
  sampleRate?: number;
  channels?: number;
  bits?: number;
  samples: number;
  padChunk?: boolean;
}): Uint8Array {
  const sampleRate = options.sampleRate ?? 22050;
  const channels = options.channels ?? 1;
  const bits = options.bits ?? 16;
  const blockAlign = (channels * bits) / 8;
  const dataBytes = options.samples * blockAlign;
  const pad = options.padChunk ? 8 + 12 : 0;
  const bytes = new Uint8Array(12 + 8 + 16 + pad + 8 + dataBytes);
  const view = new DataView(bytes.buffer);
  const writeTag = (offset: number, value: string) => {
    for (let i = 0; i < 4; i += 1) bytes[offset + i] = value.charCodeAt(i);
  };
  writeTag(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  let offset = 36;
  if (options.padChunk) {
    writeTag(offset, 'FLLR');
    view.setUint32(offset + 4, 12, true);
    offset += 20;
  }
  writeTag(offset, 'data');
  view.setUint32(offset + 4, dataBytes, true);
  return bytes;
}

function fakeDeps(overrides: Partial<SpeechSynthesizeDeps> = {}) {
  const removed: string[] = [];
  const deps: SpeechSynthesizeDeps = {
    synthesize: vi.fn(async () => ({ artifactPath: '/tmp/a.wav', engineId: 'native_say' })),
    readArtifact: vi.fn(() => buildWav({ samples: 22050 })),
    removeArtifact: vi.fn((artifactPath: string) => {
      removed.push(artifactPath);
    }),
    detectLanguage: vi.fn((text: string) => (/[ぁ-ん]/.test(text) ? 'ja' : 'en')),
    normalizeText: vi.fn((text: string) => text),
    ...overrides,
  };
  return { deps, removed };
}

describe('voice-hub synthesize request contract', () => {
  it('accepts text with an optional ja/en language (BCP-47 is narrowed)', () => {
    expect(readSpeechSynthesizeRequest({ text: '  hello ' })).toEqual({ text: 'hello' });
    expect(readSpeechSynthesizeRequest({ text: 'やあ', language: 'ja-JP' })).toEqual({
      text: 'やあ',
      language: 'ja',
    });
    expect(normalizeSpeechSynthesisLanguage('en_US')).toBe('en');
    expect(normalizeSpeechSynthesisLanguage('fr')).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['array', []],
    ['missing text', {}],
    ['blank text', { text: '   ' }],
    ['non-string text', { text: 1 }],
    ['unknown field', { text: 'hi', play: true }],
    ['unsupported language', { text: 'hi', language: 'fr' }],
  ])('rejects %s', (_label, body) => {
    expect(() => readSpeechSynthesizeRequest(body)).toThrow();
  });

  it('caps the text length', () => {
    expect(() =>
      readSpeechSynthesizeRequest({ text: 'a'.repeat(SPEECH_SYNTHESIZE_MAX_TEXT_CHARS + 1) })
    ).toThrow(/exceeds/);
  });
});

describe('parseWavInfo', () => {
  it('reads the duration from a plain 44-byte header', () => {
    expect(parseWavInfo(buildWav({ samples: 11025 }))).toEqual({
      sampleRate: 22050,
      channels: 1,
      bitsPerSample: 16,
      dataBytes: 22050,
      durationMs: 500,
    });
  });

  it('walks past padding chunks (macOS say writes FLLR before data)', () => {
    const info = parseWavInfo(
      buildWav({ samples: 44100, sampleRate: 44100, channels: 2, padChunk: true })
    );
    expect(info?.durationMs).toBe(1000);
    expect(info?.channels).toBe(2);
  });

  it('rejects non-WAVE bytes', () => {
    expect(parseWavInfo(new Uint8Array([1, 2, 3]))).toBeUndefined();
    const aiff = new TextEncoder().encode('FORM\0\0\0\0AIFFCOMM');
    expect(parseWavInfo(aiff)).toBeUndefined();
    const noData = buildWav({ samples: 0 }).slice(0, 36);
    expect(parseWavInfo(noData)).toBeUndefined();
  });
});

describe('native speak-to-file command', () => {
  it('builds say -o WAVE on macOS and espeak -w on Linux, flags before text', () => {
    expect(
      buildNativeTtsFileCommand('darwin', '-hi\u0007', { voice: 'Kyoko', rate: 180 }, '/o.wav')
    ).toEqual({
      cmd: 'say',
      args: [
        '-o',
        '/o.wav',
        '--file-format=WAVE',
        '--data-format=LEI16@22050',
        '-v',
        'Kyoko',
        '-r',
        '180',
        '--',
        '-hi',
      ],
    });
    expect(buildNativeTtsFileCommand('linux', 'hi', {}, '/o.wav')).toEqual({
      cmd: 'espeak',
      args: ['-w', '/o.wav', '--', 'hi'],
    });
    expect(buildNativeTtsFileCommand('win32', 'hi', {}, '/o.wav')).toBeNull();
  });
});

describe('estimateSpokenDurationMs', () => {
  it('counts unspaced Japanese per character', () => {
    expect(estimateSpokenDurationMs('hello world', 1200)).toBe(1200);
    expect(estimateSpokenDurationMs('こんにちは、今日はいい天気ですね', 1200)).toBe(15 * 150);
  });
});

describe('createSpeechSynthesizeHandler', () => {
  it('returns WAV bytes with timing metadata and deletes the artifact', async () => {
    const onSynthesized = vi.fn();
    const { deps, removed } = fakeDeps({ onSynthesized });
    const handler = createSpeechSynthesizeHandler(deps);

    const result = await handler({ text: 'hello' });

    expect(result.kind).toBe('audio');
    if (result.kind !== 'audio') return;
    expect(result.headers).toMatchObject({
      'Content-Type': 'audio/wav',
      'Cache-Control': 'no-store',
      'X-Kyberion-Speech-Engine': 'native_say',
      'X-Kyberion-Speech-Duration-Ms': '1000',
      'X-Kyberion-Speech-Language': 'en',
    });
    expect(result.audio.byteLength).toBeGreaterThan(44);
    expect(removed).toEqual(['/tmp/a.wav']);
    expect(onSynthesized).toHaveBeenCalledWith({
      text: 'hello',
      durationMs: 1000,
      engineId: 'native_say',
    });
  });

  it('uses the requested language, else detects it', async () => {
    const { deps } = fakeDeps();
    const handler = createSpeechSynthesizeHandler(deps);
    await handler({ text: 'hello', language: 'ja' });
    await handler({ text: 'こんにちは' });
    expect(deps.synthesize).toHaveBeenNthCalledWith(1, 'hello', 'ja');
    expect(deps.synthesize).toHaveBeenNthCalledWith(2, 'こんにちは', 'ja');
  });

  it('answers 400 / 413 before any engine work', async () => {
    const { deps } = fakeDeps();
    const handler = createSpeechSynthesizeHandler(deps);
    expect(await handler({})).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect(await handler({ text: 'a'.repeat(SPEECH_SYNTHESIZE_MAX_TEXT_CHARS + 1) })).toMatchObject(
      { status: 413, body: { error: 'text_too_long' } }
    );
    expect(deps.synthesize).not.toHaveBeenCalled();
  });

  it('answers 501 with a reason code when no engine can write audio', async () => {
    const { deps } = fakeDeps({
      synthesize: vi.fn(async () => {
        throw new SpeechSynthesisUnsupportedError('native_tts_file_output_unsupported');
      }),
    });
    const result = await createSpeechSynthesizeHandler(deps)({ text: 'hi' });
    expect(result).toEqual({
      kind: 'json',
      status: 501,
      body: {
        ok: false,
        error: 'synthesis_unsupported',
        reason: 'native_tts_file_output_unsupported',
      },
    });
  });

  it('answers 502 for a failed engine or a non-WAV artifact, still deleting it', async () => {
    const failing = fakeDeps({
      synthesize: vi.fn(async () => {
        throw new Error('bridge crashed');
      }),
    });
    expect(await createSpeechSynthesizeHandler(failing.deps)({ text: 'hi' })).toMatchObject({
      status: 502,
      body: { error: 'synthesis_failed', reason: 'bridge crashed' },
    });

    const notWav = fakeDeps({ readArtifact: vi.fn(() => new Uint8Array([0, 1, 2, 3])) });
    expect(await createSpeechSynthesizeHandler(notWav.deps)({ text: 'hi' })).toMatchObject({
      status: 502,
      body: { error: 'synthesis_artifact_invalid', reason: 'not_wav' },
    });
    expect(notWav.removed).toEqual(['/tmp/a.wav']);
  });

  it('refuses a call over the in-flight bound with 429', async () => {
    let release: () => void = () => undefined;
    const { deps } = fakeDeps({
      synthesize: vi.fn(
        () =>
          new Promise<{ artifactPath: string; engineId: string }>((resolve) => {
            release = () => resolve({ artifactPath: '/tmp/a.wav', engineId: 'x' });
          })
      ),
    });
    const handler = createSpeechSynthesizeHandler(deps, { maxInFlight: 1 });
    const first = handler({ text: 'one' });
    expect(await handler({ text: 'two' })).toMatchObject({
      status: 429,
      body: { error: 'synthesis_busy' },
    });
    release();
    expect((await first).status).toBe(200);
    // The slot is released again after completion.
    const third = handler({ text: 'three' });
    release();
    expect((await third).status).toBe(200);
  });
});
