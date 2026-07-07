/* eslint-disable no-restricted-imports */
/**
 * In-room minutes recorder — マイク録音から自動議事録まで。
 *
 * consent(purpose=recording, fail-closed)→ mic capture → EnergyVad で
 * 発話区切り → セグメント WAV をミッション evidence へ保存 → バッチ STT
 * (speech-to-text-bridge; 既定 stub は .transcript.txt sidecar)→
 * transcript.md へ追記 → stop() で pipelines/meeting-followup.json を実行し
 * minutes.md とアクションアイテムを生成する。
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';

import { checkMeetingParticipationConsent } from './meeting-participation-coordinator.js';
import { startMicCapture, type MicCaptureOptions, type MicCaptureSession } from './mic-capture.js';
import { missionEvidenceDir, rootResolve } from './path-resolver.js';
import { getSpeechToTextBridge } from './speech-to-text-bridge.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { EnergyVad, type EnergyVadOptions } from './voice-activity-detector.js';
import type { AudioChunk } from './meeting-session-types.js';

export interface InRoomMinutesOptions {
  missionId: string;
  tenantSlug?: string;
  meetingTitle?: string;
  language?: string;
  mic?: MicCaptureOptions;
  vad?: EnergyVadOptions;
  /** Max seconds per segment even without a silence endpoint. */
  maxSegmentSeconds?: number;
  onTranscriptChunk?: (chunk: { segment: number; text: string; audioPath: string }) => void;
  /** Override for tests: how the minutes pipeline is invoked on stop(). */
  runMinutesPipeline?: (input: {
    missionId: string;
    transcriptPath: string;
  }) => Promise<{ minutesPath: string }>;
}

export interface InRoomMinutesSession {
  transcriptPath: string;
  /** Resolves when capture ends (stop() or stream end). */
  done: Promise<void>;
  stop(): Promise<{ minutesPath: string | null; transcriptPath: string; segments: number }>;
}

function wavHeader(pcmBytes: number, sampleRateHz: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBytes, 40);
  return header;
}

function defaultRunMinutesPipeline(input: {
  missionId: string;
  transcriptPath: string;
}): Promise<{ minutesPath: string }> {
  return new Promise((resolve, reject) => {
    const minutesPath = path.join(missionEvidenceDir(input.missionId), 'minutes.md');
    const runner = rootResolve('dist/scripts/run_pipeline.js');
    const child = spawn(
      'node',
      [
        runner,
        '--input',
        rootResolve('pipelines/meeting-followup.json'),
        '--context',
        JSON.stringify({
          mission_id: input.missionId,
          transcript_path: input.transcriptPath,
          minutes_path: minutesPath,
        }),
      ],
      { stdio: ['ignore', 'inherit', 'inherit'], env: process.env }
    );
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ minutesPath });
      else reject(new Error(`meeting-followup pipeline exited with code ${code}`));
    });
  });
}

export async function startInRoomMinutesSession(
  options: InRoomMinutesOptions
): Promise<InRoomMinutesSession> {
  const missionId = options.missionId.toUpperCase();

  // Fail-closed recording consent (same gate as meeting participation).
  const consent = checkMeetingParticipationConsent({
    mission_id: missionId,
    tenant_slug: options.tenantSlug,
    purpose: 'recording',
  });
  if (!consent.allowed) {
    throw new Error(
      `[in-room-minutes] recording consent missing: ${consent.reason || 'not granted'}. ` +
        `Grant it with: pnpm meeting:consent grant --mission ${missionId}`
    );
  }

  const evidenceDir = missionEvidenceDir(missionId);
  const audioDir = path.join(evidenceDir, 'audio');
  safeMkdir(audioDir, { recursive: true });
  const transcriptPath = path.join(evidenceDir, 'transcript.md');
  if (!safeExistsSync(transcriptPath)) {
    safeWriteFile(
      transcriptPath,
      `# Transcript — ${options.meetingTitle || missionId}\n\n` +
        `録音開始: ${new Date().toISOString()}\n\n`
    );
  }

  const sampleRateHz = options.mic?.sampleRateHz ?? 16_000;
  const mic: MicCaptureSession = await startMicCapture({ ...options.mic, sampleRateHz });
  const vad = new EnergyVad(options.vad);
  const maxSegmentBytes = (options.maxSegmentSeconds ?? 60) * sampleRateHz * 2;
  const stt = getSpeechToTextBridge();

  let segmentIndex = 0;
  let segmentBuffers: Buffer[] = [];
  let segmentBytes = 0;
  let stopping = false;

  const appendTranscript = (text: string) => {
    const existing = safeReadFile(transcriptPath, { encoding: 'utf8' }) as string;
    safeWriteFile(transcriptPath, `${existing}${text}`);
  };

  const flushSegment = async (): Promise<void> => {
    if (segmentBytes < sampleRateHz / 4) {
      // Under ~125ms of audio: noise, drop it.
      segmentBuffers = [];
      segmentBytes = 0;
      return;
    }
    segmentIndex += 1;
    const segment = segmentIndex;
    const pcm = Buffer.concat(segmentBuffers, segmentBytes);
    segmentBuffers = [];
    segmentBytes = 0;
    const audioPath = path.join(audioDir, `segment-${String(segment).padStart(3, '0')}.wav`);
    safeWriteFile(audioPath, Buffer.concat([wavHeader(pcm.length, sampleRateHz), pcm]));
    try {
      const result = await stt.transcribe({ audioPath, language: options.language || 'ja' });
      const text = result.text.trim();
      if (text) {
        appendTranscript(`- ${text}\n`);
        options.onTranscriptChunk?.({ segment, text, audioPath });
      }
    } catch (error) {
      appendTranscript(
        `- (segment ${segment} の文字起こしに失敗: ${error instanceof Error ? error.message : String(error)})\n`
      );
    }
  };

  const captureLoop = (async () => {
    for await (const chunk of mic.chunks() as AsyncIterable<AudioChunk>) {
      segmentBuffers.push(Buffer.from(chunk.payload));
      segmentBytes += chunk.payload.byteLength;
      const state = vad.ingest(chunk);
      if (state.endpoint || segmentBytes >= maxSegmentBytes) {
        await flushSegment();
      }
      if (stopping) break;
    }
    await flushSegment();
  })();

  return {
    transcriptPath,
    done: captureLoop.then(() => undefined),
    stop: async () => {
      stopping = true;
      await mic.stop();
      await captureLoop;
      let minutesPath: string | null = null;
      if (segmentIndex > 0) {
        const run = options.runMinutesPipeline ?? defaultRunMinutesPipeline;
        const result = await run({ missionId, transcriptPath });
        minutesPath = result.minutesPath;
      }
      return { minutesPath, transcriptPath, segments: segmentIndex };
    },
  };
}
