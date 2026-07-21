import { afterEach, describe, expect, it } from 'vitest';
import { StubAudioBus } from './audio-bus.js';
import { TtsLoopbackVerifier, type TtsSource } from './tts-loopback-verifier.js';
import type { AudioChunk, TranscriptChunk } from './meeting-session-types.js';
import type { StreamingSpeechToTextBridge } from './streaming-stt-bridge.js';
import { safeRmSync } from './secure-io.js';
import * as pathResolver from './path-resolver.js';

const receiptDir = pathResolver.sharedTmp('tts-loopback-verifier-tests');
const format = {
  encoding: 'pcm_s16le' as const,
  sample_rate_hz: 16_000 as const,
  channels: 1 as const,
};

function toneChunk(): AudioChunk {
  const payload = new Uint8Array(640);
  const view = new DataView(payload.buffer);
  for (let index = 0; index < payload.byteLength / 2; index += 1)
    view.setInt16(index * 2, 1000, true);
  return { format, payload, ts_ms: 0 };
}

function tts(text: string): TtsSource {
  return {
    bridge_id: 'fixture-tts',
    async *synthesize() {
      void text;
      yield toneChunk();
      yield toneChunk();
    },
  };
}

function stt(text: string): StreamingSpeechToTextBridge {
  return {
    bridge_id: 'fixture-stt',
    async *transcribeStream(audio) {
      let chunks = 0;
      for await (const _chunk of audio) chunks += 1;
      if (chunks > 0) {
        const result: TranscriptChunk = {
          utterance_id: 'fixture-1',
          is_final: true,
          text,
          confidence: 0.99,
          emitted_at: new Date().toISOString(),
        };
        yield result;
      }
    },
  };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  request_id: 'loopback-test-001',
  text: '音声経路の確認です。',
  audio_route: { bus: 'stub' as const },
  timing: { pre_roll_ms: 0, post_roll_ms: 0 },
  persistence: { output_dir: receiptDir },
  ...overrides,
});

afterEach(() => safeRmSync(receiptDir, { recursive: true, force: true }));

describe('TtsLoopbackVerifier', () => {
  it('passes deterministic TTS → StubAudioBus → STT verification', async () => {
    const result = await new TtsLoopbackVerifier({
      bus: new StubAudioBus(),
      tts: tts('音声経路の確認です。'),
      stt: stt('音声経路の確認です。'),
      checkConsent: () => ({ allowed: true }),
    }).verify(request());
    expect(result.status).toBe('passed');
    expect(result.source).toBe('self_tts_loopback');
    expect(result.capture.chunks).toBeGreaterThan(0);
    expect(result.verification.character_error_rate).toBe(0);
  });

  it('fails when STT returns an empty final transcript', async () => {
    const result = await new TtsLoopbackVerifier({
      bus: new StubAudioBus(),
      tts: tts('音声経路の確認です。'),
      stt: stt(''),
      checkConsent: () => ({ allowed: true }),
    }).verify(request({ request_id: 'loopback-empty-stt' }));
    expect(result.status).toBe('failed');
    expect(result.verification.reasons).toContain('STT returned an empty final transcript');
  });

  it('blocks output without consent and supports dry-run without touching the bus', async () => {
    const blocked = await new TtsLoopbackVerifier({
      bus: new StubAudioBus(),
      tts: tts('test'),
      stt: stt('test'),
      checkConsent: () => ({ allowed: false, reason: 'operator confirmation required' }),
    }).verify(request({ request_id: 'loopback-blocked' }));
    expect(blocked.status).toBe('blocked');
    const dryRun = await new TtsLoopbackVerifier({
      bus: new StubAudioBus(),
      tts: tts('test'),
      stt: stt('test'),
      checkConsent: () => ({ allowed: true }),
    }).verify(request({ request_id: 'loopback-dry-run', dry_run: true }));
    expect(dryRun.status).toBe('blocked');
    expect(dryRun.warnings[0]).toMatch(/dry_run/);
  });
});
