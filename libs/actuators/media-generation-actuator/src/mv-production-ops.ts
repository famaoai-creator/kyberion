// MV production ops: lyric normalization, vocal alignment, storyboard
// planning, and ffmpeg composition. Backend-neutral: concrete runtimes
// resolve through tool-runtimes (faster_whisper / ffmpeg) and
// media-backends; the ops themselves only orchestrate.

import os from 'node:os';
import path from 'node:path';
import { logger } from '@agent/core/core';
import {
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { getRegisteredEnvText, parseSafeJsonInput, readJson } from '@agent/core/foundation';
import {
  resolveManagedToolPythonBin,
  resolveToolRuntimeCommand,
} from '@agent/core/tool/tool-runtime-registry';

type Params = Record<string, unknown>;

function srtTimestamp(sec: number): string {
  const clamped = Math.max(0, sec);
  const ms = Math.round((clamped % 1) * 1000);
  const s = Math.floor(clamped) % 60;
  const m = Math.floor(clamped / 60) % 60;
  const h = Math.floor(clamped / 3600);
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

// ---------- lyric_normalize ----------

type LyricReadings = { ascii_kana: Record<string, string>; latin_kana: Record<string, string> };

let cachedReadings: LyricReadings | null = null;
function loadLyricReadings(): LyricReadings {
  if (cachedReadings) return cachedReadings;
  cachedReadings = readJson<LyricReadings>(
    pathResolver.rootResolve('libs/actuators/media-generation-actuator/data/lyric-readings.json')
  );
  return cachedReadings;
}

/**
 * Normalize lyrics into a singable phonetic form for vocal-music generators
 * (e.g. ACE-Step). ASCII/romaji tokens are katakana-ized so the vocal model
 * does not misread them; callers may pass `reading_overrides` to pin
 * specific surface forms to explicit readings (e.g. { "ログ": "ろぐ" }).
 */
export function lyricNormalize(params: Params): Record<string, unknown> {
  const lyricsPath = String(params.lyrics_path ?? '');
  const lyrics = lyricsPath
    ? String(safeReadFile(lyricsPath))
    : String(params.lyrics ?? params.display_lyrics ?? '');
  if (!lyrics.trim())
    throw new Error('lyric_normalize requires params.lyrics or params.lyrics_path');
  const overrides =
    params.reading_overrides && typeof params.reading_overrides === 'object'
      ? (params.reading_overrides as Record<string, string>)
      : {};
  const conversions: Array<{ surface: string; reading: string }> = [];
  const readings = loadLyricReadings();

  let sing = lyrics;
  for (const [surface, reading] of Object.entries(overrides)) {
    if (sing.includes(surface)) {
      sing = sing.split(surface).join(reading);
      conversions.push({ surface, reading });
    }
  }
  sing = sing.replace(/[A-Za-z][A-Za-z0-9]*/g, (token) => {
    const reading =
      readings.ascii_kana[token] ??
      readings.ascii_kana[token.toUpperCase()] ??
      token
        .split('')
        .map((ch) => readings.latin_kana[ch.toUpperCase()] ?? ch)
        .join('');
    conversions.push({ surface: token, reading });
    return reading;
  });
  return {
    display_lyrics: lyrics,
    sing_lyrics: sing,
    conversions,
    conversion_count: conversions.length,
  };
}

// ---------- vocal_align ----------

export type VocalSegment = {
  start_sec: number;
  end_sec: number;
  text: string;
  words?: Array<{ start_sec: number; end_sec: number; word: string }>;
};

function resolveAlignPython(): string {
  const env =
    getRegisteredEnvText('KYBERION_PYTHON_BIN') || getRegisteredEnvText('KYBERION_PYTHON');
  if (env) return env;
  for (const toolId of ['faster_whisper', 'mlx_whisper'] as const) {
    const managed = resolveManagedToolPythonBin(toolId);
    if (managed) return managed;
  }
  const venv = pathResolver.rootResolve('.venv/bin/python3');
  if (safeExistsSync(venv)) return venv;
  return 'python3';
}

/**
 * Time-align lyrics against a generated audio file using the managed
 * faster-whisper runtime. When `lyrics` lines are provided they are mapped
 * onto detected vocal segments (two lines per segment, split at 55%), and
 * an SRT file is written next to the audio unless `srt_path` overrides it.
 */
export async function vocalAlign(params: Params): Promise<Record<string, unknown>> {
  const audioPath = String(params.audio_path ?? '');
  if (!audioPath || !safeExistsSync(audioPath)) {
    throw new Error(`vocal_align: audio_path not found: ${audioPath || '(empty)'}`);
  }
  const script = pathResolver.rootResolve(
    'libs/actuators/voice-actuator/scripts/faster_whisper_stt_bridge.py'
  );
  const result = safeExecResult(resolveAlignPython(), ['-X', 'utf8', script], {
    input: JSON.stringify({
      action: 'transcribe',
      params: {
        audio_path: audioPath,
        language: String(params.language ?? 'ja'),
        word_timestamps: true,
      },
    }),
    env: { KYBERION_PROJECT_ROOT: pathResolver.rootResolve('.') },
    timeoutMs: 600_000,
    maxOutputMB: 16,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`vocal_align bridge failed: ${result.stderr || result.error?.message}`);
  }
  const response = parseSafeJsonInput(result.stdout, 'vocal_align bridge response') as {
    status: string;
    error?: string;
    segments?: VocalSegment[];
  };
  if (response.status !== 'success' || !response.segments) {
    throw new Error(`vocal_align bridge error: ${response.error || 'invalid response'}`);
  }
  const segments = response.segments;

  const lyricLines = Array.isArray(params.lyrics)
    ? params.lyrics.map((l) => String(l).trim()).filter(Boolean)
    : String(params.lyrics ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

  const srtEntries: Array<{ start: number; end: number; text: string }> = [];
  if (lyricLines.length > 0 && segments.length > 0) {
    // Distribute lyric lines over vocal segments proportionally.
    let li = 0;
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      const remainingSegs = segments.length - si;
      const remainingLines = lyricLines.length - li;
      const take = Math.max(1, Math.ceil(remainingLines / remainingSegs));
      const lines = lyricLines.slice(li, li + take);
      li += take;
      const slice = (seg.end_sec - seg.start_sec) / lines.length;
      lines.forEach((line, i) => {
        srtEntries.push({
          start: seg.start_sec + slice * i,
          end: seg.start_sec + slice * (i + 1),
          text: line,
        });
      });
      if (li >= lyricLines.length) break;
    }
  } else {
    for (const seg of segments) {
      srtEntries.push({ start: seg.start_sec, end: seg.end_sec, text: seg.text });
    }
  }

  const srtPath = String(params.srt_path ?? `${audioPath.replace(/\.[^.]+$/, '')}.aligned.srt`);
  const body = srtEntries
    .map((e, i) => `${i + 1}\n${srtTimestamp(e.start)} --> ${srtTimestamp(e.end)}\n${e.text}\n`)
    .join('\n');
  safeMkdir(path.dirname(srtPath), { recursive: true });
  safeWriteFile(srtPath, body);
  return {
    audio_path: audioPath,
    segment_count: segments.length,
    lyric_lines: lyricLines.length,
    srt_path: srtPath,
    segments,
  };
}

// ---------- mv_storyboard ----------

export type MvScene = {
  id: number;
  start: number;
  end: number;
  visual: string;
  motion: string;
  lyric: string;
};

function parseSrt(text: string): Array<{ start: number; end: number; text: string }> {
  const cues: Array<{ start: number; end: number; text: string }> = [];
  // Parse block-by-block with an anchored pattern (no /g scan over the whole
  // document) so pathological inputs cannot cause polynomial backtracking.
  const cueRe =
    /^(\d+)[ \t]*\r?\n(\d{2}):(\d{2}):(\d{2})[,.](\d{3})[ \t]*-->[ \t]*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})[ \t]*\r?\n([^\n]+)/;
  for (const block of text.split(/\r?\n[ \t]*\r?\n/)) {
    const m = cueRe.exec(block.trim());
    if (!m) continue;
    const t = (h: string, mm: string, ss: string, ms: string) =>
      Number(h) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms) / 1000;
    cues.push({
      start: t(m[2], m[3], m[4], m[5]),
      end: t(m[6], m[7], m[8], m[9]),
      text: m[10].trim(),
    });
  }
  return cues;
}

/**
 * Build a scene plan from an (aligned) lyric SRT plus bookend cues. Merges
 * lyric cues into scenes no shorter than `min_scene_sec` (default 5s) and
 * seeds visual/motion prompts from the lyric text — callers (a semantic
 * brief or a human editor) refine the prompts afterwards.
 */
export function mvStoryboard(params: Params): Record<string, unknown> {
  const srtPath = String(params.srt_path ?? '');
  const srtText = srtPath ? String(safeReadFile(srtPath)) : String(params.srt ?? '');
  if (!srtText.trim()) throw new Error('mv_storyboard requires params.srt_path or params.srt');
  const cues = parseSrt(srtText);
  const durationSec = Number(params.duration_sec ?? 0);
  const minSceneSec = Number(params.min_scene_sec ?? 5);
  const style = String(params.style ?? '');
  const leadInSec = Number(params.lead_in_sec ?? cues[0]?.start ?? 0);
  const outroSec = durationSec || (cues.at(-1)?.end ?? 0) + Number(params.outro_sec ?? 8);

  const scenes: MvScene[] = [];
  const pushScene = (start: number, end: number, lyric: string) => {
    scenes.push({
      id: scenes.length + 1,
      start,
      end,
      lyric,
      visual: lyric || (style ? `${style}, establishing shot` : 'establishing shot'),
      motion: lyric || 'slow ambient motion',
    });
  };
  if (leadInSec > 0.5) pushScene(0, cues[0]?.start ?? leadInSec, '');
  let cur: { start: number; end: number; lines: string[] } | null = null;
  for (const cue of cues) {
    if (cur && cue.start - cur.start >= minSceneSec) {
      pushScene(cur.start, cue.start, cur.lines.join(' / '));
      cur = null;
    }
    if (!cur) cur = { start: cue.start, end: cue.end, lines: [] };
    cur.end = cue.end;
    cur.lines.push(cue.text);
  }
  if (cur) pushScene(cur.start, cur.end, cur.lines.join(' / '));
  if (scenes.at(-1) && outroSec - scenes.at(-1)!.end > 0.5) {
    pushScene(scenes.at(-1)!.end, outroSec, '');
  }
  const outputPath = String(params.output_path ?? '');
  const storyboard = { version: 1, style, min_scene_sec: minSceneSec, scenes };
  if (outputPath) {
    safeMkdir(path.dirname(outputPath), { recursive: true });
    safeWriteFile(outputPath, JSON.stringify(storyboard, null, 2));
  }
  return { ...storyboard, output_path: outputPath || undefined, scene_count: scenes.length };
}

// ---------- mv_compose ----------

export function buildMvComposeArgs(opts: {
  inputs: string[];
  filterComplex: string;
  audioPath: string;
  audioInputIndex: number;
  videoLabel: string;
  fps: number;
  outputPath: string;
}): string[] {
  return [
    '-y',
    ...opts.inputs,
    '-i',
    opts.audioPath,
    '-filter_complex',
    opts.filterComplex,
    '-map',
    opts.videoLabel,
    '-map',
    `${opts.audioInputIndex}:a`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(opts.fps),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-shortest',
    opts.outputPath,
  ];
}

/**
 * Compose an MV from a storyboard (scene stills or generated clips),
 * aligned lyric SRT, and audio. Uses the governed ffmpeg tool runtime;
 * renders PNG-free subtitles via the `subtitles` filter when available,
 * otherwise muxes the SRT as a sidecar mov_text track.
 */
export async function mvCompose(params: Params): Promise<Record<string, unknown>> {
  const storyboardPath = String(params.storyboard_path ?? params.scenes_path ?? '');
  if (!storyboardPath || !safeExistsSync(storyboardPath)) {
    throw new Error(`mv_compose: storyboard_path not found: ${storyboardPath || '(empty)'}`);
  }
  const storyboard = readJson<{
    scenes: Array<{ start: number; end: number; img?: string; clip?: string }>;
  }>(storyboardPath);
  const audioPath = String(params.audio_path ?? '');
  const srtPath = String(params.srt_path ?? '');
  const outputPath = String(params.output_path ?? '');
  if (!audioPath || !safeExistsSync(audioPath)) {
    throw new Error(`mv_compose: audio_path not found: ${audioPath || '(empty)'}`);
  }
  if (!outputPath) throw new Error('mv_compose requires params.output_path');
  const baseDir = path.dirname(storyboardPath);
  const fps = Number(params.fps ?? 30);
  const W = Number(params.width ?? 1280);
  const H = Number(params.height ?? 720);

  const ffmpegCmd = resolveToolRuntimeCommand('ffmpeg', 'installed')?.command ?? 'ffmpeg';
  const filters = safeExecResult(ffmpegCmd, ['-hide_banner', '-filters'], { timeoutMs: 15000 });
  const hasSubtitles = /subtitles/.test(filters.stdout);

  const inputs: string[] = [];
  const chains: string[] = [];
  storyboard.scenes.forEach((sc, i) => {
    const dur = sc.end - sc.start;
    const rel = (p?: string) => (p ? (path.isAbsolute(p) ? p : path.join(baseDir, p)) : p);
    if (sc.clip && safeExistsSync(rel(sc.clip)!)) {
      inputs.push('-stream_loop', '-1', '-i', rel(sc.clip)!);
      chains.push(
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},setsar=1,trim=duration=${dur},setpts=PTS-STARTPTS[v${i}]`
      );
    } else {
      const img = rel(sc.img);
      if (!img || !safeExistsSync(img)) throw new Error(`mv_compose: scene ${i} has no img/clip`);
      inputs.push('-i', img);
      const n = Math.round(dur * fps);
      const zdir = i % 2 ? -0.00015 : 0.00015;
      chains.push(
        `[${i}:v]scale=1920:1080,zoompan=z='min(zoom+${zdir},1.15)':d=${n}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps},setsar=1[v${i}]`
      );
    }
  });
  const vlabels = storyboard.scenes.map((_, i) => `[v${i}]`).join('');
  let videoChain = `${vlabels}concat=n=${storyboard.scenes.length}:v=1:a=0[vbase]`;
  if (hasSubtitles && srtPath && safeExistsSync(srtPath)) {
    // Escape ffmpeg subtitles-filter metacharacters. Windows separators are
    // normalized to '/' first; backslashes are then backslash-escaped along
    // with the other filter special chars (single-pass, no bypass).
    const esc = srtPath.replace(/\\/g, '/').replace(/([':;,\[\]\\])/g, '\\$1');
    videoChain += `;[vbase]subtitles='${esc}'[vout]`;
  }
  const filterComplex = chains.join(';') + ';' + videoChain;

  const args = buildMvComposeArgs({
    inputs,
    filterComplex,
    audioPath,
    audioInputIndex: storyboard.scenes.length,
    videoLabel: hasSubtitles ? '[vout]' : '[vbase]',
    fps,
    outputPath,
  });
  safeMkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  const run = safeExecResult(ffmpegCmd, args, {
    timeoutMs: Number(params.timeout_ms ?? 600_000),
    cwd: baseDir,
  });
  if (run.error || run.status !== 0) {
    throw new Error(`mv_compose ffmpeg failed: ${run.stderr?.slice(-2000) || run.error?.message}`);
  }
  logger.info(`mv_compose wrote ${outputPath} (${storyboard.scenes.length} scenes)`);
  return {
    output_path: outputPath,
    scene_count: storyboard.scenes.length,
    subtitles: hasSubtitles && srtPath ? 'burned' : srtPath ? 'sidecar' : 'none',
    srt_path: hasSubtitles ? undefined : srtPath || undefined,
    fps,
    width: W,
    height: H,
    backend: 'ffmpeg',
    os: os.platform(),
  };
}

export async function handleMvOp(action: string, params: Params): Promise<Record<string, unknown>> {
  if (action === 'lyric_normalize') return lyricNormalize(params);
  if (action === 'vocal_align') return vocalAlign(params);
  if (action === 'mv_storyboard') return mvStoryboard(params);
  if (action === 'mv_compose') return mvCompose(params);
  throw new Error(`Unsupported mv op: ${action}`);
}
