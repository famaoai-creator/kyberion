/**
 * Streaming Text-To-Speech bridge.
 *
 * Mirrors `streaming-stt-bridge.ts` from the other direction: take a
 * stream of text segments, return a stream of PCM audio chunks the
 * audio bus can write to the meeting's mic input. Streaming matters
 * here too — sentence-by-sentence synthesis lets the AI start speaking
 * before the full reply is built, which is the difference between a
 * 200ms response and a 6-second one.
 *
 * Implementations: Piper / Coqui XTTS / ElevenLabs streaming / Azure
 * Neural TTS. We ship a stub + a shell-out adapter; vendor specifics
 * register their own bridge.
 */

import type { AudioChunk, AudioFormat } from './meeting-session-types.js';

export interface StreamingTextToSpeechBridge {
  readonly bridge_id: string;
  /** Audio format the bridge emits; coordinators must match it. */
  readonly format: AudioFormat;
  /**
   * Synthesize a stream of text segments into a stream of PCM chunks.
   * `voice_profile_id` ties back to `voice-profile-registry.json`.
   */
  synthesizeStream(
    text: AsyncIterable<string>,
    voice_profile_id: string,
  ): AsyncIterable<AudioChunk>;
}

/* ------------------------------------------------------------------ *
 * StubStreamingTextToSpeechBridge
 *
 * Emits one tiny PCM chunk per text segment. Lets the coordinator's
 * "speak then write to bus" path be exercised without a real TTS.
 * ------------------------------------------------------------------ */

export class StubStreamingTextToSpeechBridge implements StreamingTextToSpeechBridge {
  readonly bridge_id = 'stub';
  readonly format: AudioFormat = {
    encoding: 'pcm_s16le',
    sample_rate_hz: 16000,
    channels: 1,
  };

  async *synthesizeStream(
    text: AsyncIterable<string>,
    _voice_profile_id: string,
  ): AsyncIterable<AudioChunk> {
    let ts = 0;
    for await (const segment of text) {
      const payload = new Uint8Array(Buffer.from(segment, 'utf8'));
      yield { format: this.format, payload, ts_ms: ts };
      ts += 200;
    }
  }
}

const _streamingTtsRegistry = new Map<string, () => StreamingTextToSpeechBridge>();

export function registerStreamingTtsBridge(
  id: string,
  factory: () => StreamingTextToSpeechBridge,
): void {
  _streamingTtsRegistry.set(id, factory);
}

export function getStreamingTtsBridge(
  id: string = process.env.KYBERION_STREAMING_TTS_BRIDGE ?? 'stub',
): StreamingTextToSpeechBridge {
  if (id === 'stub') return new StubStreamingTextToSpeechBridge();
  const factory = _streamingTtsRegistry.get(id);
  if (!factory) throw new Error(`[streaming-tts] unknown bridge id '${id}'`);
  return factory();
}
