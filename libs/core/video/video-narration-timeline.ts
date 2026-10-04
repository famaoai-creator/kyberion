/**
 * Narration-first scene timing.
 *
 * Scene length comes from the measured narration of that scene (plus a short
 * lead-in and hold), not from an estimate or a fixed split, so on-screen cues
 * land on the words. The per-scene clips are then laid onto one narration
 * track at each scene's offset, which is what the composition muxes.
 */
import * as path from 'node:path';
import { safeExec, safeMkdir } from '../secure-io.js';
import { resolveFfmpegBin, resolveFfprobeBin } from '../tool/tool-binary-resolvers.js';

export interface NarrationSegmentInput {
  scene_id: string;
  /** Measured narration length for the scene in seconds (0 / absent → silent scene). */
  narration_sec?: number;
  /** Minimum on-screen time, e.g. for a closing logo hold. */
  min_sec?: number;
}

export interface NarrationTimedScene {
  scene_id: string;
  start_sec: number;
  duration_sec: number;
  narration_sec: number;
  /** Absolute time the scene's narration starts on the mixed track. */
  narration_offset_sec: number;
}

export interface NarrationTimelinePlan {
  scenes: NarrationTimedScene[];
  total_duration_sec: number;
}

export interface NarrationTimelineOptions {
  /** Silence before each scene's narration (seconds). */
  lead_sec?: number;
  /** Hold after each scene's narration (seconds). */
  tail_sec?: number;
  /** Floor for scenes without narration or min_sec. */
  silent_scene_sec?: number;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export function planNarrationTimeline(
  segments: NarrationSegmentInput[],
  options: NarrationTimelineOptions = {}
): NarrationTimelinePlan {
  const lead = options.lead_sec ?? 0.6;
  const tail = options.tail_sec ?? 0.9;
  const silent = options.silent_scene_sec ?? 3;
  let cursor = 0;
  const scenes = segments.map((segment) => {
    const narration = Math.max(0, Number(segment.narration_sec) || 0);
    const spoken = narration > 0 ? narration + lead + tail : silent;
    const duration = round3(Math.max(spoken, Number(segment.min_sec) || 0));
    const scene: NarrationTimedScene = {
      scene_id: segment.scene_id,
      start_sec: round3(cursor),
      duration_sec: duration,
      narration_sec: round3(narration),
      narration_offset_sec: round3(cursor + (narration > 0 ? lead : 0)),
    };
    cursor += duration;
    return scene;
  });
  return { scenes, total_duration_sec: round3(cursor) };
}

/** Duration of an audio artifact in seconds via ffprobe. */
export function probeAudioDurationSec(audioPath: string): number {
  const out = safeExec(
    resolveFfprobeBin(),
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath],
    { timeoutMs: 30_000 }
  );
  const seconds = Number(String(out).trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`probeAudioDurationSec: no duration for ${audioPath}`);
  }
  return seconds;
}

/**
 * Lay each scene's narration clip onto one stereo track at its offset, padded
 * to the full timeline so the muxed video is not cut short.
 */
export function mixNarrationTimeline(
  plan: NarrationTimelinePlan,
  clips: Record<string, string>,
  outputPath: string
): string {
  const voiced = plan.scenes.filter((scene) => scene.narration_sec > 0 && clips[scene.scene_id]);
  if (voiced.length === 0) {
    throw new Error('mixNarrationTimeline: no scene has a narration clip');
  }
  safeMkdir(path.dirname(outputPath), { recursive: true });
  const inputs: string[] = [];
  const filters: string[] = [];
  voiced.forEach((scene, index) => {
    inputs.push('-i', clips[scene.scene_id]);
    const ms = Math.round(scene.narration_offset_sec * 1000);
    filters.push(
      `[${index}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[v${index}]`
    );
  });
  const labels = voiced.map((_, index) => `[v${index}]`).join('');
  const total = plan.total_duration_sec.toFixed(3);
  filters.push(
    `${labels}amix=inputs=${voiced.length}:normalize=0,apad=whole_dur=${total},atrim=0:${total}[out]`
  );
  safeExec(
    resolveFfmpegBin(),
    ['-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', outputPath],
    { timeoutMs: 120_000 }
  );
  return outputPath;
}
