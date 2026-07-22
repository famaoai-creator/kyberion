/* eslint-disable no-restricted-imports */
/**
 * InRoomMeetingJoinDriver (同席モード) — non-browser meeting attendance.
 *
 * Instead of joining Meet/Zoom/Teams through browser automation, Kyberion
 * attends the meeting the user is physically in: `audioInput()` is the
 * machine's microphone (mic-capture) and `audioOutput()` plays through the
 * speakers (afplay on macOS / aplay on Linux). Everything downstream —
 * MeetingParticipationCoordinator, consent gates, STT/VAD, minutes — is
 * unchanged; that is the point of the MeetingJoinDriver seam.
 *
 * Remote-native drivers (`zoom-sdk`, `recall-ai`) remain future work and
 * plug into the same registry.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';

import type { AudioBus } from './audio-bus.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeWriteFile } from './secure-io.js';
import {
  probeMicCapture,
  startMicCapture,
  type MicCaptureOptions,
  type MicCaptureSession,
} from './mic-capture.js';
import type { MeetingJoinDriver } from './meeting-join-driver.js';
import { registerMeetingJoinDriver } from './meeting-join-driver.js';
import type {
  AudioChunk,
  MeetingSession,
  MeetingSessionState,
  MeetingTarget,
} from './meeting-session-types.js';
import { abortableAudioChunks } from './meeting-session-types.js';

export interface InRoomMeetingDriverOptions {
  mic?: MicCaptureOptions;
  /**
   * Playback command override (argv; receives a WAV file path appended).
   * Defaults to afplay (darwin) / aplay (linux). Tests inject a no-op.
   */
  playbackCommand?: string[];
  /**
   * Pause mic capture while speaking to avoid re-capturing our own output
   * (simple echo suppression). Default true.
   */
  pauseCaptureWhileSpeaking?: boolean;
}

function wavHeader(pcmBytes: number, sampleRateHz: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBytes, 40);
  return header;
}

function defaultPlaybackCommand(): string[] | null {
  if (process.platform === 'darwin') return ['afplay'];
  if (process.platform === 'linux') return ['aplay', '-q'];
  return null;
}

export class InRoomMeetingJoinDriver implements MeetingJoinDriver {
  readonly driver_id = 'in-room';
  readonly supported_platforms = ['in_room'] as const;

  constructor(private readonly options: InRoomMeetingDriverOptions = {}) {}

  async probe(): Promise<{ available: boolean; reason?: string }> {
    const micProbe = probeMicCapture(this.options.mic);
    if (!micProbe.available) {
      return { available: false, reason: micProbe.reason };
    }
    if (!this.options.playbackCommand && !defaultPlaybackCommand()) {
      return {
        available: false,
        reason: `no audio playback command available on platform ${process.platform}`,
      };
    }
    return { available: true };
  }

  async join(target: MeetingTarget, _bus: AudioBus): Promise<MeetingSession> {
    const mic: MicCaptureSession = await startMicCapture(this.options.mic);
    const playback = this.options.playbackCommand ?? defaultPlaybackCommand();
    const pauseWhileSpeaking = this.options.pauseCaptureWhileSpeaking !== false;
    const tmpDir = pathResolver.shared(path.join('tmp', 'in-room-audio', Date.now().toString(36)));
    safeMkdir(tmpDir, { recursive: true });

    const state: MeetingSessionState = {
      session_id: `in-room-${Date.now().toString(36)}`,
      platform: 'in_room',
      status: 'in_meeting',
      joined_at: new Date().toISOString(),
    };
    let left = false;
    let speaking = false;
    let utteranceIndex = 0;

    const playWav = (wavPath: string, signal?: AbortSignal): Promise<void> =>
      new Promise((resolve, reject) => {
        if (!playback) {
          resolve();
          return;
        }
        if (signal?.aborted) {
          resolve();
          return;
        }
        const child = spawn(playback[0], [...playback.slice(1), wavPath], { stdio: 'ignore' });
        const stop = (): void => {
          child.kill('SIGTERM');
        };
        signal?.addEventListener('abort', stop, { once: true });
        child.on('error', reject);
        child.on('close', () => {
          signal?.removeEventListener('abort', stop);
          resolve();
        });
      });

    return {
      state,
      async *audioInput(): AsyncIterable<AudioChunk> {
        for await (const chunk of mic.chunks()) {
          if (left) return;
          // Simple echo suppression: drop room audio while we are speaking.
          if (pauseWhileSpeaking && speaking) continue;
          yield chunk;
        }
      },
      audioOutput: async (
        stream: AsyncIterable<AudioChunk>,
        signal?: AbortSignal
      ): Promise<void> => {
        speaking = true;
        try {
          const buffers: Buffer[] = [];
          let sampleRateHz = 16_000;
          for await (const chunk of abortableAudioChunks(stream, signal)) {
            buffers.push(Buffer.from(chunk.payload));
            sampleRateHz = chunk.format.sample_rate_hz;
          }
          if (buffers.length === 0 || signal?.aborted) return;
          const pcm = Buffer.concat(buffers);
          utteranceIndex += 1;
          const wavPath = path.join(tmpDir, `utterance-${utteranceIndex}.wav`);
          safeWriteFile(wavPath, Buffer.concat([wavHeader(pcm.length, sampleRateHz), pcm]));
          await playWav(wavPath, signal);
        } finally {
          speaking = false;
        }
      },
      async chat(_text: string): Promise<void> {
        // No text channel in the physical room.
      },
      leave: async (): Promise<void> => {
        left = true;
        state.status = 'ended';
        state.left_at = new Date().toISOString();
        await mic.stop();
      },
    };
  }
}

export function installInRoomMeetingJoinDriver(options?: InRoomMeetingDriverOptions): void {
  registerMeetingJoinDriver(new InRoomMeetingJoinDriver(options));
}
