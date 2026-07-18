import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { resolveVoicePath } from './voice-path-policy.js';

describe('voice-path-policy', () => {
  it('accepts governed voice staging and runtime paths', () => {
    expect(resolveVoicePath('active/shared/tmp/voice-test/sample.wav', 'recording-output')).toContain(
      'active/shared/tmp/voice-test/sample.wav',
    );
    expect(resolveVoicePath('active/shared/runtime/voice-profiles/test/sample.wav', 'audio-input')).toContain(
      'active/shared/runtime/voice-profiles/test/sample.wav',
    );
  });

  it('rejects traversal and foreign absolute paths', () => {
    expect(() => resolveVoicePath('../../outside.wav', 'recording-output')).toThrow(/project root/u);
    expect(() => resolveVoicePath('/tmp/outside.wav', 'recording-output')).toThrow(/project root/u);
  });

  it('keeps transcript output within approved voice roots', () => {
    expect(() => resolveVoicePath('docs/transcript.txt', 'transcript-output')).toThrow(
      /approved voice data directory/u,
    );
    expect(resolveVoicePath(pathResolver.sharedTmp('stt-sidecars/test.txt'), 'transcript-output')).toContain(
      'active/shared/tmp/stt-sidecars/test.txt',
    );
  });
});
