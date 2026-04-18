import { describe, expect, it } from 'vitest';
import { concatenateVoiceAudioChunks, splitVoiceTextIntoChunks } from './voice-text-chunking.js';

describe('voice text chunking', () => {
  it('keeps abbreviations from forcing a split', () => {
    const text = 'Dr. Sato reviewed the plan. The next sentence should split cleanly for narration.';
    const chunks = splitVoiceTextIntoChunks(text, 45);
    expect(chunks[0]).toContain('Dr. Sato');
    expect(chunks[0].endsWith('.')).toBe(true);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('does not split inside paralinguistic tags', () => {
    const text = 'This opening [laugh softly] should stay intact even when the line is long enough to require chunking.';
    const chunks = splitVoiceTextIntoChunks(text, 35);
    expect(chunks.join(' ')).toContain('[laugh softly]');
    expect(chunks.some((chunk) => chunk.includes('[laugh'))).toBe(true);
    expect(chunks.some((chunk) => chunk.includes('softly]'))).toBe(true);
  });

  it('crossfades adjacent audio chunks', () => {
    const merged = concatenateVoiceAudioChunks(
      [
        [1, 1, 1, 1],
        [0, 0, 0, 0],
      ],
      1000,
      2,
    );
    expect(merged.length).toBe(6);
    expect(merged[2]).toBeGreaterThan(0);
    expect(merged[3]).toBeLessThan(1);
  });
});
