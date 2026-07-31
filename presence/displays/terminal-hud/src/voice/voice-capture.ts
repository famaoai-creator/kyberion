import path from 'node:path';
import {
  startMicCapture,
  getSpeechToTextBridge,
  installFluidAudioSpeechToTextBridgeIfAvailable,
  installShellSpeechToTextBridgeIfAvailable,
  pcmToWav,
  pathResolver,
} from '@agent/core';
import type { MicCaptureOptions, TranscribeResult } from '@agent/core';
import { ensureDir, safeUnlinkSync, safeWriteFile } from '@agent/core/secure-io';

export interface VoiceCaptureHandle {
  /** Stop capturing and return the recorded audio as a WAV buffer. */
  stop(): Promise<Buffer>;
}

let bridgesInstalled = false;

function ensureSttBridges(): void {
  if (bridgesInstalled) return;
  bridgesInstalled = true;
  try {
    installFluidAudioSpeechToTextBridgeIfAvailable();
    installShellSpeechToTextBridgeIfAvailable();
  } catch {
    // bridge installation is best-effort; getSpeechToTextBridge falls back
  }
}

export async function beginVoiceCapture(opts: MicCaptureOptions = {}): Promise<VoiceCaptureHandle> {
  const sampleRateHz = opts.sampleRateHz ?? 16000;
  const session = await startMicCapture({ ...opts, sampleRateHz });
  const buffers: Buffer[] = [];
  const collecting = (async () => {
    for await (const chunk of session.chunks()) {
      buffers.push(Buffer.from(chunk.payload));
    }
  })();
  return {
    async stop(): Promise<Buffer> {
      await session.stop();
      await collecting.catch(() => {
        // capture process teardown errors are not fatal for the transcript
      });
      return pcmToWav(Buffer.concat(buffers), sampleRateHz);
    },
  };
}

export async function transcribeWavBuffer(wav: Buffer): Promise<TranscribeResult> {
  ensureSttBridges();
  const dir = pathResolver.active('shared/tmp/terminal-hud-voice');
  ensureDir(dir);
  const audioPath = path.join(dir, `capture-${Date.now().toString(36)}.wav`);
  safeWriteFile(audioPath, wav);
  try {
    return await getSpeechToTextBridge().transcribe({ audioPath });
  } finally {
    try {
      safeUnlinkSync(audioPath);
    } catch {
      // temp cleanup is best-effort
    }
  }
}
