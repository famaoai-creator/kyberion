import { describe, expect, it } from 'vitest';
import { BargeInController } from './barge-in-controller.js';
import type { AudioChunk, AudioFormat } from './meeting-session-types.js';

const format: AudioFormat = { encoding: 'pcm_s16le', sample_rate_hz: 16_000, channels: 1 };

function chunk(amplitude: number, durationMs = 100): AudioChunk {
  const payload = new Uint8Array((format.sample_rate_hz * durationMs * 2) / 1000);
  const view = new DataView(payload.buffer);
  for (let offset = 0; offset < payload.byteLength; offset += 2) {
    view.setInt16(offset, amplitude, true);
  }
  return { format, payload, ts_ms: 0 };
}

describe('BargeInController', () => {
  it('requires sustained speech and returns the buffered leading chunks once', () => {
    const controller = new BargeInController({
      base_rms_threshold: 800,
      threshold_multiplier: 2,
      min_speech_ms: 250,
    });

    expect(controller.observe(chunk(3_000)).triggered).toBe(false);
    expect(controller.observe(chunk(3_000)).triggered).toBe(false);
    const triggered = controller.observe(chunk(3_000));

    expect(triggered.triggered).toBe(true);
    expect(triggered.buffered_chunks).toHaveLength(3);
    expect(controller.observe(chunk(3_000)).triggered).toBe(false);
    expect(controller.observe(chunk(0)).speaking).toBe(false);
  });

  it('rejects unsafe detector tuning', () => {
    expect(
      () => new BargeInController({ base_rms_threshold: 800, threshold_multiplier: 0.5 })
    ).toThrow(/threshold_multiplier/);
    expect(() => new BargeInController({ base_rms_threshold: 800, min_speech_ms: 0 })).toThrow(
      /min_speech_ms/
    );
  });
});
