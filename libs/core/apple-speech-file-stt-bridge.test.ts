import { describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

const mocks = vi.hoisted(() => ({
  safeExecResult: vi.fn(() => ({ stdout: '{"ok":true,"text":"hello"}', stderr: '', status: 0 })),
  safeExistsSync: vi.fn(() => true),
  safeWriteFile: vi.fn(),
}));

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return {
    ...actual,
    safeExecResult: mocks.safeExecResult,
    safeExistsSync: mocks.safeExistsSync,
    safeWriteFile: mocks.safeWriteFile,
  };
});

describe('apple speech file stt bridge', () => {
  it('routes Apple Speech environment reads through the governed accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/apple-speech-file-stt-bridge.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });

  it('normalizes the native JSON envelope and rejects malformed shapes', async () => {
    const { normalizeAppleSpeechFilePayload } = await import('./apple-speech-file-stt-bridge.js');

    expect(normalizeAppleSpeechFilePayload([])).toBeUndefined();
    expect(normalizeAppleSpeechFilePayload({ ok: 'true', text: 'hello' })).toBeUndefined();
    expect(normalizeAppleSpeechFilePayload({ ok: true, text: 42 })).toBeUndefined();
    expect(normalizeAppleSpeechFilePayload({ ok: false, error: 'no_speech_result' })).toEqual({
      ok: false,
      error: 'no_speech_result',
    });
  });

  it('skips malformed stdout records before accepting a valid result', async () => {
    mocks.safeExecResult.mockReturnValueOnce({
      stdout: 'loader noise\n[]\n{"ok":true,"text":"hello","locale":"en-US"}\n',
      stderr: '',
      status: 0,
    });
    const { transcribeAudioFileWithAppleSpeech } =
      await import('./apple-speech-file-stt-bridge.js');

    expect(transcribeAudioFileWithAppleSpeech('AGENTS.md', { locale: 'en' })).toEqual({
      text: 'hello',
      locale: 'en-US',
    });
  });

  it('rejects an audio input outside the repository', async () => {
    mocks.safeExecResult.mockClear();
    const { transcribeAudioFileWithAppleSpeech } =
      await import('./apple-speech-file-stt-bridge.js');

    expect(() => transcribeAudioFileWithAppleSpeech('/tmp/outside-call.wav')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
    expect(mocks.safeExecResult).not.toHaveBeenCalled();
  });
});
