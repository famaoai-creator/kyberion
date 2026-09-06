import { describe, expect, it } from 'vitest';
import { extensionCaptionsToTranscript } from './extension-transcript.js';

const JSONL = [
  JSON.stringify({ text: 'Hello everyone', speaker: 'Alice', ts: '2026-09-06T09:00:05+09:00' }),
  JSON.stringify({ text: 'welcome back', speaker: 'Alice', ts: '2026-09-06T09:00:09+09:00' }),
  JSON.stringify({ text: '予算確定です', speaker: 'Bob', ts: '2026-09-06T09:01:05+09:00' }),
  JSON.stringify({ text: '   ', speaker: 'Bob', ts: '2026-09-06T09:01:06+09:00' }),
  'not json {{{',
  JSON.stringify({ speaker: 'Bob', ts: '2026-09-06T09:01:07+09:00' }),
].join('\n');

describe('extensionCaptionsToTranscript', () => {
  it('renders cues with relative timestamps and speaker merge', () => {
    const result = extensionCaptionsToTranscript(JSONL);
    expect(result.cueCount).toBe(2);
    expect(result.speakers).toEqual(['Alice', 'Bob']);
    expect(result.transcript).toBe(
      '[00:00] Alice: Hello everyone welcome back\n[01:00] Bob: 予算確定です'
    );
  });

  it('returns empty output for caption-less input', () => {
    expect(extensionCaptionsToTranscript('\n')).toEqual({
      transcript: '',
      cueCount: 0,
      speakers: [],
    });
  });
});
