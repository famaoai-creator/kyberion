import { describe, expect, it } from 'vitest';
import { UserRhythm } from './user-rhythm.js';

function utterance(rhythm: UserRhythm, gapMs: number, durationMs: number, at: { now: number }) {
  rhythm.observeSpeechStart(at.now);
  at.now += gapMs;
  rhythm.observeUtterance({ durationMs, transcriptChars: 30, atMs: at.now });
  at.now += durationMs;
}

describe('UserRhythm', () => {
  it('returns no adjustments before the sample floor', () => {
    const rhythm = new UserRhythm({ minSamples: 4 });
    const at = { now: 0 };
    utterance(rhythm, 1000, 2000, at);
    utterance(rhythm, 1000, 2000, at);
    expect(rhythm.adjustments()).toBeNull();
  });

  it('stretches the EOT hold for users who pause longer', () => {
    const rhythm = new UserRhythm({ minSamples: 2 });
    const at = { now: 0 };
    utterance(rhythm, 0, 1000, at);
    at.now += 4000; // long inter-utterance gap
    utterance(rhythm, 0, 1000, at);
    at.now += 4000;
    rhythm.observeSpeechStart(at.now);
    const adjustments = rhythm.adjustments();
    expect(adjustments).not.toBeNull();
    // gap ~4000ms → maxHold targets ~min(2×1500, 4000×1.5→6000 capped 3000)
    expect(adjustments!.maxHoldMs).toBeGreaterThan(1500);
    expect(adjustments!.maxHoldMs).toBeLessThanOrEqual(3000);
  });

  it('clamps adjustments to [0.5×, 2×] the base', () => {
    const rhythm = new UserRhythm({
      minSamples: 1,
      base: { maxHoldMs: 1500, tentativeSilenceMs: 250, backchannelIntervalMs: 4000 },
    });
    const at = { now: 0 };
    at.now += 100; // tiny gap → tiny tentative silence
    utterance(rhythm, 0, 500, at);
    const adjustments = rhythm.adjustments()!;
    expect(adjustments.maxHoldMs).toBeGreaterThanOrEqual(750);
    expect(adjustments.tentativeSilenceMs).toBeGreaterThanOrEqual(125);
    expect(adjustments.tentativeSilenceMs).toBeLessThanOrEqual(500);
  });

  it('shortens the backchannel interval for aizuchi-heavy users', () => {
    const rhythm = new UserRhythm({ minSamples: 2 });
    const at = { now: 0 };
    utterance(rhythm, 0, 1000, at);
    rhythm.observeUserBackchannel();
    rhythm.observeUserBackchannel();
    utterance(rhythm, 0, 1000, at);
    const adjustments = rhythm.adjustments()!;
    expect(adjustments.backchannelIntervalMs).toBeLessThan(4000);
    expect(adjustments.backchannelIntervalMs).toBeGreaterThanOrEqual(2000);
  });
});
