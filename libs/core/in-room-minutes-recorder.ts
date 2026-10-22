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

import { t } from './t.js';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

import { checkMeetingParticipationConsent } from './meeting/meeting-participation-coordinator.js';
import {
  pcmRms,
  startMicCapture,
  type MicCaptureOptions,
  type MicCaptureSession,
} from './mic-capture.js';
import { createWorkItemIfAbsent } from './workforce/work-coordination.js';
import { missionEvidenceDir, rootResolve } from './path-resolver.js';
import { resolvePolicyIdentityContext } from './identity-context-bridge.js';
import { nowIso } from './foundation/time.js';
import { readTextFile } from './foundation/text.js';
import { wavHeader } from './pcm-wav.js';
import { getSpeechToTextBridge } from './voice/speech-to-text-bridge.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from './secure-io.js';
import { EnergyVad, type EnergyVadOptions } from './voice/voice-activity-detector.js';
import type { AudioChunk } from './meeting/meeting-session-types.js';
import { resolveLocale } from './locale.js';

export interface InRoomMinutesOptions {
  missionId: string;
  tenantSlug?: string;
  /** The meeting being recorded (calendar series id / URL for a standing grant). */
  meeting?: { url?: string; series_id?: string };
  meetingTitle?: string;
  language?: string;
  mic?: MicCaptureOptions;
  vad?: EnergyVadOptions;
  /** Max seconds per segment even without a silence endpoint. */
  maxSegmentSeconds?: number;
  onTranscriptChunk?: (chunk: { segment: number; text: string; audioPath: string }) => void;
  /**
   * Canonical WorkItem the follow-up reasoning runs under. When unset, one is
   * created for the mission on stop() (mission-scoped meeting reasoning
   * requires it).
   */
  workItemId?: string;
  /** Consecutive seconds below the silence floor before warning (default 60; 0 disables). */
  silenceWarnSeconds?: number;
  /**
   * RMS (0..1) under which a chunk counts as silent (default 0.002, about
   * -54 dBFS: above ADC noise of a muted bus, below a quiet room's voice).
   * In `both` mode the mix includes the mic's noise floor, so a dead
   * loopback bus alone is not detected.
   */
  silenceRmsFloor?: number;
  /** Test seam: coordination store root for the auto-created WorkItem. */
  workItemRootDir?: string;
  onSilenceWarning?: (info: { seconds: number }) => void;
  /** Override for tests: how the minutes pipeline is invoked on stop(). */
  runMinutesPipeline?: (input: {
    missionId: string;
    transcriptPath: string;
    workItemId: string;
  }) => Promise<{ minutesPath: string }>;
}

export interface InRoomMinutesSession {
  transcriptPath: string;
  /** Resolves when capture ends (stop() or stream end). */
  done: Promise<void>;
  stop(): Promise<{ minutesPath: string | null; transcriptPath: string; segments: number }>;
}

function resolveMissionEvidenceDir(missionId: string): string {
  const evidenceDir = missionEvidenceDir(missionId);
  if (!evidenceDir) {
    throw new Error(`[in-room-minutes] mission evidence dir not found for ${missionId}`);
  }
  return assertSafeRepositoryPath(evidenceDir, { allowMissingLeaf: true });
}

/** The minutes WorkItem id for a mission; stable so a rerun finds the same item. */
export function minutesWorkItemId(missionId: string): string {
  return `WI-${missionId.toUpperCase().replace(/^MSN-/u, '')}-MINUTES`;
}

function ensureMinutesWorkItem(missionId: string, tenantSlug: string, rootDir?: string): string {
  const itemId = minutesWorkItemId(missionId);
  createWorkItemIfAbsent({
    rootDir,
    itemId,
    title: t('minutes_record:work_item_title', { missionId }, 'ja'),
    description: t('minutes_record:work_item_description', { missionId }, 'ja'),
    context: {
      tenant_slug: tenantSlug,
      mission_id: missionId,
      work_shape: 'governance_cadence',
    },
  });
  return itemId;
}

function defaultRunMinutesPipeline(input: {
  missionId: string;
  transcriptPath: string;
  workItemId: string;
}): Promise<{ minutesPath: string }> {
  return new Promise((resolve, reject) => {
    const evidenceDir = resolveMissionEvidenceDir(input.missionId);
    const minutesPath = assertSafeRepositoryPath(path.join(evidenceDir, 'minutes.md'), {
      allowMissingLeaf: true,
    });
    const runner = assertSafeRepositoryPath(rootResolve('dist/scripts/run_pipeline.js'));
    const pipeline = assertSafeRepositoryPath(rootResolve('pipelines/meeting-followup.json'));
    const child = spawn(
      'node',
      [
        runner,
        '--input',
        pipeline,
        '--context',
        JSON.stringify({
          mission_id: input.missionId,
          work_item_id: input.workItemId,
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
  // One tenant for the consent gate and the WorkItem, resolved up front.
  const tenantSlug = options.tenantSlug ?? resolvePolicyIdentityContext().tenantSlug;

  // Fail-closed recording consent (same gate as meeting participation).
  const consent = checkMeetingParticipationConsent({
    mission_id: missionId,
    tenant_slug: tenantSlug,
    purpose: 'recording',
    ...(options.meeting ? { meeting: options.meeting } : {}),
  });
  if (!consent.allowed) {
    throw new Error(
      `[in-room-minutes] recording consent missing: ${consent.reason || 'not granted'}. ` +
        `Grant it with: pnpm meeting:consent grant --mission ${missionId}` +
        (consent.remedy ? `, or ahead of time: ${consent.remedy}` : '')
    );
  }

  // The follow-up reasoning needs a WorkItem scoped to a tenant. Settle it
  // before capture starts: failing after the meeting would lose the minutes.
  let workItemId = options.workItemId;
  if (!workItemId) {
    if (!tenantSlug) {
      throw new Error(
        '[in-room-minutes] tenant required for the minutes WorkItem — set KYBERION_TENANT or pass --tenant (or pass --work-item)'
      );
    }
    try {
      workItemId = ensureMinutesWorkItem(missionId, tenantSlug, options.workItemRootDir);
    } catch (error) {
      throw new Error(
        `[in-room-minutes] cannot prepare the minutes WorkItem ${minutesWorkItemId(missionId)} — ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          'If it exists under another tenant, pass --work-item <id> to use a different one.'
      );
    }
  }

  const evidenceDir = resolveMissionEvidenceDir(missionId);
  const audioDir = assertSafeRepositoryPath(path.join(evidenceDir, 'audio'), {
    allowMissingLeaf: true,
  });
  safeMkdir(audioDir, { recursive: true });
  const transcriptPath = assertSafeRepositoryPath(path.join(evidenceDir, 'transcript.md'), {
    allowMissingLeaf: true,
  });
  if (safeExistsSync(transcriptPath)) {
    if (!safeLstat(transcriptPath).isFile()) {
      throw new Error(
        `[IN_ROOM_MINUTES_RESOURCE] transcript must be a regular file: ${transcriptPath}`
      );
    }
  } else {
    safeWriteFile(
      transcriptPath,
      `# Transcript — ${options.meetingTitle || missionId}\n\n` + `録音開始: ${nowIso()}\n\n`
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

  const silenceWarnSeconds = options.silenceWarnSeconds ?? 60;
  const silenceRmsFloor = options.silenceRmsFloor ?? 0.002;
  let silentBytes = 0;
  let silenceWarned = false;
  const watchSilence = (chunk: AudioChunk) => {
    if (pcmRms(chunk.payload) >= silenceRmsFloor) {
      // Sound heard: end this silent run and re-arm the warning.
      silentBytes = 0;
      silenceWarned = false;
      return;
    }
    silentBytes += chunk.payload.byteLength;
    if (silenceWarnSeconds <= 0 || silenceWarned) return;
    const seconds = silentBytes / (sampleRateHz * 2);
    if (seconds >= silenceWarnSeconds) {
      silenceWarned = true;
      try {
        options.onSilenceWarning?.({ seconds: Math.round(seconds) });
      } catch {
        // A faulty observer must not stop the recording.
      }
    }
  };

  const appendTranscript = (text: string) => {
    if (!safeLstat(transcriptPath).isFile()) {
      throw new Error(
        `[IN_ROOM_MINUTES_RESOURCE] transcript must be a regular file: ${transcriptPath}`
      );
    }
    const existing = readTextFile(transcriptPath);
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
    const audioPath = assertSafeRepositoryPath(
      path.join(audioDir, `segment-${String(segment).padStart(3, '0')}.wav`),
      { allowMissingLeaf: true }
    );
    safeWriteFile(audioPath, Buffer.concat([wavHeader(pcm.length, sampleRateHz), pcm]));
    try {
      // I18N-06: an unset recording language follows the resolved locale
      // (identity/env/OS), not a hardcoded 'ja' — same pattern as
      // `python-voice-bridge.ts`'s TTS language (I18N-01).
      const result = await stt.transcribe({
        audioPath,
        language: options.language || resolveLocale(),
      });
      const text = result.text.trim();
      if (text) {
        appendTranscript(`- ${text}\n`);
        options.onTranscriptChunk?.({ segment, text, audioPath });
      }
    } catch (error) {
      appendTranscript(
        `- ${t('minutes_record:segment_transcription_failed', {
          segment,
          detail: error instanceof Error ? error.message : String(error),
        })}\n`
      );
    }
  };

  const captureLoop = (async () => {
    for await (const chunk of mic.chunks() as AsyncIterable<AudioChunk>) {
      watchSilence(chunk);
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
        const result = await run({ missionId, transcriptPath, workItemId: workItemId as string });
        minutesPath = result.minutesPath;
      }
      return { minutesPath, transcriptPath, segments: segmentIndex };
    },
  };
}
