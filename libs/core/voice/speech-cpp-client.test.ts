import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveSpeechCppAsrModel,
  resolveSpeechCppBaseUrl,
  resolveSpeechCppTtsModel,
  resolveSpeechCppVoice,
  synthesizeSpeechCppCli,
  transcribeSpeechCppCli,
} from './speech-cpp-client.js';

describe('speech-cpp-client', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves defaults and env overrides', () => {
    expect(resolveSpeechCppBaseUrl()).toBe('http://127.0.0.1:8095');
    expect(resolveSpeechCppTtsModel()).toBe('qwen3-tts-0.6b');
    expect(resolveSpeechCppAsrModel()).toBe('qwen3-asr-0.6b');
    vi.stubEnv('KYBERION_SPEECH_CPP_URL', 'http://127.0.0.1:9000/');
    vi.stubEnv('KYBERION_SPEECH_CPP_TTS_MODEL', 'irodori-tts-mf');
    vi.stubEnv('KYBERION_SPEECH_CPP_ASR_MODEL', 'reazonspeech-v2');
    expect(resolveSpeechCppBaseUrl()).toBe('http://127.0.0.1:9000');
    expect(resolveSpeechCppTtsModel()).toBe('irodori-tts-mf');
    expect(resolveSpeechCppAsrModel()).toBe('reazonspeech-v2');
  });

  it('picks Qwen3-TTS voices by language when unset', () => {
    expect(resolveSpeechCppVoice(undefined, 'en')).toBe('ryan');
    expect(resolveSpeechCppVoice(undefined, 'ja-JP')).toBe('ono_anna');
    expect(resolveSpeechCppVoice('vivian', 'ja')).toBe('vivian');
  });

  it('runs speech tts via the resolved binary', () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const result = synthesizeSpeechCppCli(
      {
        text: 'Hello.',
        outputPath: '/tmp/speech-cpp-out.wav',
        language: 'en',
      },
      {
        resolveBin: () => '/opt/speech',
        exec,
        existsSync: () => true,
      }
    );
    expect(exec).toHaveBeenCalledWith(
      '/opt/speech',
      ['tts', 'qwen3-tts-0.6b', '--voice', 'ryan', '-o', '/tmp/speech-cpp-out.wav', 'Hello.'],
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expect(result.via).toBe('cli');
    expect(result.voice).toBe('ryan');
  });

  it('runs speech asr via the resolved binary', () => {
    const exec = vi.fn().mockReturnValue({
      status: 0,
      stdout: '  Hello from ASR. \n',
      stderr: '',
    });
    const result = transcribeSpeechCppCli(
      { audioPath: '/tmp/in.wav', language: 'en' },
      {
        resolveBin: () => '/opt/speech',
        exec,
        existsSync: () => true,
      }
    );
    expect(exec).toHaveBeenCalledWith(
      '/opt/speech',
      ['asr', 'qwen3-asr-0.6b', '--language', 'en', '/tmp/in.wav'],
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expect(result.text).toBe('Hello from ASR.');
  });
});
