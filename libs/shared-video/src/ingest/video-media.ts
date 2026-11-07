import * as path from 'node:path';
import { runVideoTool } from './video-fetch.js';
import type {
  VideoChapter,
  VideoCommandRunner,
  VideoKeyframeReason,
} from './video-ingest-types.js';

const FFMPEG_BASE_ARGS = ['-nostdin', '-hide_banner', '-y', '-v', 'error'];

/** 16 kHz mono PCM WAV — the input shape every STT bridge accepts. */
export async function extractAudioWav(
  runner: VideoCommandRunner,
  ffmpegBin: string,
  inputPath: string,
  outputPath: string
): Promise<string> {
  await runVideoTool(
    runner,
    'ffmpeg',
    ffmpegBin,
    [
      ...FFMPEG_BASE_ARGS,
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      outputPath,
    ],
    { timeoutMs: 15 * 60_000 }
  );
  return outputPath;
}

export async function extractFrame(
  runner: VideoCommandRunner,
  ffmpegBin: string,
  inputPath: string,
  outputPath: string,
  atSec: number
): Promise<string> {
  await runVideoTool(
    runner,
    'ffmpeg',
    ffmpegBin,
    [
      ...FFMPEG_BASE_ARGS,
      '-ss',
      formatSeconds(atSec),
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-q:v',
      '3',
      outputPath,
    ],
    { timeoutMs: 60_000 }
  );
  return outputPath;
}

export function formatSeconds(value: number): string {
  return Math.max(0, value).toFixed(3);
}

/** Parse `pts_time:<seconds>` markers from ffmpeg showinfo output. */
export function parseSceneTimes(stderr: string): number[] {
  const times: number[] = [];
  for (const line of stderr.split('\n')) {
    const index = line.indexOf('pts_time:');
    if (index < 0) continue;
    const value = Number.parseFloat(line.slice(index + 'pts_time:'.length));
    if (Number.isFinite(value)) times.push(value);
  }
  return times;
}

export async function detectSceneChanges(
  runner: VideoCommandRunner,
  ffmpegBin: string,
  inputPath: string,
  threshold: number
): Promise<number[]> {
  const result = await runVideoTool(
    runner,
    'ffmpeg',
    ffmpegBin,
    [
      '-nostdin',
      '-hide_banner',
      '-nostats',
      '-v',
      'info',
      '-i',
      inputPath,
      '-vf',
      `select='gt(scene,${threshold})',showinfo`,
      '-an',
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 15 * 60_000, maxOutputMB: 20 }
  );
  return parseSceneTimes(result.stderr);
}

export interface KeyframePlanInput {
  duration_sec: number;
  chapters: VideoChapter[];
  scene_times: number[];
  interval_sec: number;
  max_keyframes: number;
  /** Candidates closer than this to an already chosen frame are dropped. */
  min_gap_sec?: number;
}

export interface PlannedKeyframe {
  t_sec: number;
  reason: VideoKeyframeReason;
}

/**
 * Chapter starts first, then scene cuts, then fixed intervals; candidates too
 * close to an already chosen frame are dropped and the plan is capped at
 * `max_keyframes`, returned in time order.
 */
export function planKeyframes(input: KeyframePlanInput): PlannedKeyframe[] {
  const minGap = input.min_gap_sec ?? 2;
  const limit = Math.max(0, Math.floor(input.max_keyframes));
  const duration = Math.max(0, input.duration_sec);
  const within = (t: number) => t >= 0 && (duration === 0 || t < duration);
  const intervals: number[] = [];
  if (input.interval_sec > 0) {
    for (let t = 0; t < duration; t += input.interval_sec) intervals.push(t);
  }
  const candidates: PlannedKeyframe[] = [
    ...input.chapters.map((chapter) => ({ t_sec: chapter.start_sec, reason: 'chapter' as const })),
    ...[...input.scene_times]
      .sort((a, b) => a - b)
      .map((t) => ({ t_sec: t, reason: 'scene' as const })),
    ...intervals.map((t) => ({ t_sec: t, reason: 'interval' as const })),
  ];
  const chosen: PlannedKeyframe[] = [];
  for (const candidate of candidates) {
    if (chosen.length >= limit) break;
    if (!within(candidate.t_sec)) continue;
    if (chosen.some((frame) => Math.abs(frame.t_sec - candidate.t_sec) < minGap)) continue;
    chosen.push({ t_sec: Math.round(candidate.t_sec * 1000) / 1000, reason: candidate.reason });
  }
  return chosen.sort((a, b) => a.t_sec - b.t_sec);
}

export async function extractKeyframes(
  runner: VideoCommandRunner,
  ffmpegBin: string,
  inputPath: string,
  outputDir: string,
  plan: PlannedKeyframe[]
): Promise<Array<PlannedKeyframe & { path: string }>> {
  const frames: Array<PlannedKeyframe & { path: string }> = [];
  for (const [index, frame] of plan.entries()) {
    const outputPath = path.join(outputDir, `keyframe-${String(index + 1).padStart(4, '0')}.jpg`);
    await extractFrame(runner, ffmpegBin, inputPath, outputPath, frame.t_sec);
    frames.push({ ...frame, path: outputPath });
  }
  return frames;
}
