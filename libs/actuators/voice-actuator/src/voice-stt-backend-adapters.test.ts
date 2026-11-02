import { describe, expect, it } from 'vitest';
import {
  listVoiceLoopbackSttFactoryIds,
  registerVoiceLoopbackSttAdapter,
  registerVoiceLoopbackSttFactory,
} from './voice-stt-backend-adapters.js';

describe('voice loopback STT factory registry', () => {
  it('registers built-in factories without an if-chain at call sites', () => {
    expect(listVoiceLoopbackSttFactoryIds()).toEqual([
      'faster_whisper',
      'mlx_whisper',
      'speech_cpp',
    ]);
  });

  it('rejects unknown bridge ids with the registered set in the message', () => {
    expect(() =>
      registerVoiceLoopbackSttAdapter('not-a-bridge', {
        request_id: 'r1',
        language: 'en',
      })
    ).toThrow(/not-a-bridge/);
  });

  it('allows an extension factory to be registered and disposed', () => {
    const dispose = registerVoiceLoopbackSttFactory('ext_loopback', () => ({
      bridge_id: 'ext_loopback',
      async *transcribeStream() {
        /* empty */
      },
    }));
    expect(listVoiceLoopbackSttFactoryIds()).toContain('ext_loopback');
    dispose();
    expect(listVoiceLoopbackSttFactoryIds()).not.toContain('ext_loopback');
  });
});
