import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import { parseShellStreamingSttTranscript } from './shell-streaming-stt-bridge.js';

describe('shell streaming STT transcript boundary', () => {
  it('routes Shell streaming STT environment reads through the governed accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/shell-streaming-stt-bridge.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });

  it('maps a valid object into a transcript chunk', () => {
    const chunk = parseShellStreamingSttTranscript(
      '{"utterance_id":"u1","is_final":true,"text":"こんにちは","confidence":0.92,"speaker_label":"operator"}'
    );

    expect(chunk).toMatchObject({
      utterance_id: 'u1',
      is_final: true,
      text: 'こんにちは',
      confidence: 0.92,
      speaker_label: 'operator',
    });
    expect(chunk?.emitted_at).toBeTruthy();
  });

  it('rejects arrays and dangerous JSON keys before event creation', () => {
    expect(() => parseShellStreamingSttTranscript('[]')).toThrow(/must be a JSON object/);
    expect(() => parseShellStreamingSttTranscript('{"__proto__":{"text":"injected"}}')).toThrow(
      /dangerous JSON key/
    );
  });

  it('preserves the bridge defaults for a safe empty object', () => {
    const chunk = parseShellStreamingSttTranscript('{}');
    expect(chunk).toMatchObject({ is_final: true, text: '' });
    expect(chunk?.utterance_id).toBeTruthy();
  });
});
