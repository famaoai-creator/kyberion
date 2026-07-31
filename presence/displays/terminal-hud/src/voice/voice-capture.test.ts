import { afterEach, describe, expect, it } from 'vitest';
import {
  registerSpeechToTextBridge,
  resetSpeechToTextBridge,
  NO_TIMESTAMP_STT_CAPABILITIES,
} from '@agent/core';
import { safeExistsSync } from '@agent/core/secure-io';
import { beginVoiceCapture, transcribeWavBuffer } from './voice-capture.js';

afterEach(() => {
  resetSpeechToTextBridge();
});

describe('beginVoiceCapture', () => {
  it('collects PCM from a fixture command and returns a WAV buffer', async () => {
    const handle = await beginVoiceCapture({
      sampleRateHz: 16000,
      command: ['node', '-e', 'process.stdout.write(Buffer.alloc(32000, 7))'],
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const wav = await handle.stop();
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.length).toBeGreaterThan(44);
  }, 15000);
});

describe('transcribeWavBuffer', () => {
  it('writes a temp WAV under active/shared/tmp, transcribes, and cleans up', async () => {
    let receivedPath: string | undefined;
    registerSpeechToTextBridge({
      name: 'hud-test-bridge',
      capabilities: NO_TIMESTAMP_STT_CAPABILITIES,
      priority: 100,
      async transcribe(input) {
        receivedPath = input.audioPath;
        expect(safeExistsSync(input.audioPath)).toBe(true);
        return { text: 'こんにちは', backend: 'hud-test-bridge' };
      },
    });
    const result = await transcribeWavBuffer(Buffer.from('RIFFxxxxWAVE'));
    expect(result.text).toBe('こんにちは');
    expect(receivedPath).toContain('terminal-hud-voice');
    expect(safeExistsSync(receivedPath ?? '')).toBe(false);
  });
});
