/**
 * `pnpm kyberion watch <video> [--every <sec>] [--max-frames <n>] [--no-ocr]
 *   [--no-audio] [--frames <dir>] [--lang <bcp47>] [--json] [--out <file>]`
 *
 * Perceives a video the way `read` perceives a document: ffprobe for the
 * metadata, a sampled frame timeline OCR'd locally (same path as `see`), and
 * the audio track transcribed by the same code as `listen`. Media work runs
 * through the platform media runner; scratch lives in a unique shared-tmp
 * dir that is removed afterwards (frames are copied out only with --frames).
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeCopyFileSync, safeMkdir, safeReaddir } from '@agent/core/secure-io';
import type { TranscriptSegment } from '@agent/core/speech-to-text-bridge';
import { ScriptExitError } from './lib/harness.js';
import { transcribeMediaFile } from './cli-listen.js';
import {
  assertExtension,
  createPerceptionWorkDir,
  defaultPerceptionDeps,
  emitOutput,
  explainMediaError,
  formatTimestamp,
  isInsideRepository,
  NoTranscriptError,
  parseCommonOption,
  removeWorkDir,
  renderSegments,
  resolveRepositoryInput,
  VIDEO_EXTENSIONS,
  type CommonArgs,
  type PerceptionDeps,
} from './lib/perception.js';

const DEFAULT_MAX_FRAMES = 24;

export const WATCH_USAGE = `Usage: pnpm kyberion watch <video> [--every <sec>] [--max-frames <n>] [--no-ocr] [--no-audio] [--frames <dir>] [--lang <bcp47>] [--json] [--out <file>]

Perceives a ${VIDEO_EXTENSIONS.join(' / ')} video: metadata, audio transcript, and an OCR'd frame timeline (local only).
  --every <sec>     Sample one frame every <sec> seconds (default: spread --max-frames over the duration)
  --max-frames <n>  Upper bound on sampled frames (default ${DEFAULT_MAX_FRAMES})
  --no-ocr          Skip frame OCR (timeline lists timestamps only)
  --no-audio        Skip the audio transcript
  --frames <dir>    Keep the sampled frames as PNGs in <dir> (inside the repository)
  --lang <tag>      Language hint for OCR and speech, e.g. ja, en
  --json            Print {file, metadata, transcript, frames, warnings} as JSON
  --out <file>      Write the Markdown (or JSON) to a file inside the repository instead of stdout
  --verbose         Keep runtime logs (they go to stdout; off by default so stdout is the content)

Needs ffmpeg (macOS: brew install ffmpeg). The file must be inside the repository. Copy external files first, e.g.
  mkdir -p active/shared/tmp/<job> && cp ~/Downloads/<video> active/shared/tmp/<job>/`;

interface WatchArgs extends CommonArgs {
  every?: number;
  maxFrames: number;
  ocr: boolean;
  audio: boolean;
  frames?: string;
}

export interface VideoMetadata {
  duration_sec: number;
  width?: number;
  height?: number;
  video_codec?: string;
  has_audio: boolean;
}

export interface WatchFrame {
  time_sec: number;
  text?: string;
  path?: string;
}

export interface WatchResult {
  file: string;
  metadata: VideoMetadata;
  every_sec: number;
  transcript?: { backend: string; language?: string; text: string; segments?: TranscriptSegment[] };
  frames: WatchFrame[];
  warnings: string[];
}

function positiveNumber(flag: string, raw: string | undefined): number {
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value <= 0) {
    throw new ScriptExitError(1, `${flag} requires a positive number`);
  }
  return value;
}

function parseWatchArgs(argv: string[]): WatchArgs {
  const args: WatchArgs = {
    json: false,
    help: false,
    maxFrames: DEFAULT_MAX_FRAMES,
    ocr: true,
    audio: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    const common = parseCommonOption(args, argv, index);
    if (common) {
      index += common.consumed;
      continue;
    }
    if (value === '--no-ocr') args.ocr = false;
    else if (value === '--no-audio') args.audio = false;
    else if (value === '--every') {
      args.every = positiveNumber('--every', argv[index + 1]);
      index += 1;
    } else if (value === '--max-frames') {
      args.maxFrames = Math.floor(positiveNumber('--max-frames', argv[index + 1]));
      if (args.maxFrames < 1)
        throw new ScriptExitError(1, '--max-frames requires a positive number');
      index += 1;
    } else if (value === '--frames') {
      args.frames = argv[index + 1];
      index += 1;
      if (!args.frames) throw new ScriptExitError(1, '--frames requires a directory');
    } else if (value.startsWith('--')) throw new ScriptExitError(1, `Unknown option: ${value}`);
    else if (!args.file) args.file = value;
    else throw new ScriptExitError(1, `Unexpected argument: ${value}`);
  }
  return args;
}

export function parseFfprobeMetadata(stdout: string): VideoMetadata {
  let parsed: {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      duration?: string;
    }>;
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('ffprobe returned non-JSON output');
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const duration = Number(parsed.format?.duration ?? video?.duration ?? 0);
  return {
    duration_sec: Number.isFinite(duration) ? duration : 0,
    ...(video?.width ? { width: video.width } : {}),
    ...(video?.height ? { height: video.height } : {}),
    ...(video?.codec_name ? { video_codec: video.codec_name } : {}),
    has_audio: streams.some((stream) => stream.codec_type === 'audio'),
  };
}

/** Character-bigram Dice similarity of whitespace-normalized text. */
function similarity(left: string, right: string): number {
  const a = left.replace(/\s+/g, ' ').trim().toLowerCase();
  const b = right.replace(/\s+/g, ' ').trim().toLowerCase();
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const key = a.slice(i, i + 2);
    bigrams.set(key, (bigrams.get(key) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const key = b.slice(i, i + 2);
    const count = bigrams.get(key) ?? 0;
    if (count > 0) {
      overlap += 1;
      bigrams.set(key, count - 1);
    }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

/** Drop frames whose OCR text repeats the previous kept frame (near-duplicates). */
export function dropDuplicateFrames(frames: WatchFrame[], threshold = 0.9): WatchFrame[] {
  const kept: WatchFrame[] = [];
  for (const frame of frames) {
    const previous = kept[kept.length - 1];
    if (
      previous &&
      frame.text !== undefined &&
      previous.text !== undefined &&
      similarity(previous.text, frame.text) >= threshold
    ) {
      continue;
    }
    kept.push(frame);
  }
  return kept;
}

export function renderWatchResult(result: WatchResult, asJson: boolean): string {
  if (asJson) return JSON.stringify(result, null, 2);
  const meta = result.metadata;
  const lines = [
    `# ${path.basename(result.file)}`,
    '',
    `- file: ${result.file}`,
    `- duration: ${formatTimestamp(meta.duration_sec)} (${meta.duration_sec.toFixed(1)}s)`,
  ];
  if (meta.width && meta.height) {
    lines.push(
      `- resolution: ${meta.width}×${meta.height}${meta.video_codec ? ` (${meta.video_codec})` : ''}`
    );
  }
  lines.push(`- audio: ${meta.has_audio ? 'yes' : 'none'}`, `- frames: every ${result.every_sec}s`);
  if (result.transcript) {
    const t = result.transcript;
    lines.push(
      '',
      '## Transcript',
      '',
      `_backend: ${t.backend}${t.language ? `, language ${t.language}` : ''}_`,
      ''
    );
    lines.push(
      t.segments && t.segments.length > 0
        ? renderSegments(t.segments)
        : t.text.trim() || '_(no speech recognized)_'
    );
  }
  lines.push('', '## Frames');
  for (const frame of result.frames) {
    lines.push('', `### ${formatTimestamp(frame.time_sec)}`);
    if (frame.path) lines.push('', `frame: ${frame.path}`);
    if (frame.text !== undefined) lines.push('', frame.text.trim() || '_(no text)_');
  }
  if (result.warnings.length > 0) lines.push('', ...result.warnings.map((w) => `> [watch] ${w}`));
  return lines.join('\n');
}

export async function runWatchCommand(
  argv: string[],
  print: (text: string) => void,
  deps: PerceptionDeps = defaultPerceptionDeps
): Promise<WatchResult | undefined> {
  const args = parseWatchArgs(argv);
  if (args.help || !args.file) {
    if (!args.file && !args.help) throw new ScriptExitError(1, WATCH_USAGE);
    print(WATCH_USAGE);
    return undefined;
  }
  const absolute = resolveRepositoryInput('watch', args.file);
  assertExtension(
    'watch',
    absolute,
    VIDEO_EXTENSIONS,
    'Audio-only files: use `pnpm kyberion listen`.'
  );
  const framesDir = args.frames ? pathResolver.rootResolve(args.frames) : undefined;
  if (framesDir && !isInsideRepository(framesDir)) {
    throw new ScriptExitError(
      1,
      `[watch] --frames ${args.frames} must be a directory inside the repository`
    );
  }

  let metadata: VideoMetadata;
  try {
    metadata = parseFfprobeMetadata(
      await deps.runMedia('ffprobe', [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        absolute,
      ])
    );
  } catch (error) {
    explainMediaError('watch', error);
  }

  const warnings: string[] = [];
  const duration = metadata.duration_sec > 0 ? metadata.duration_sec : 1;
  const every = args.every ?? Math.max(1, Math.ceil((duration / args.maxFrames) * 10) / 10);
  const wanted = Math.floor(duration / every) + 1;
  if (wanted > args.maxFrames) {
    warnings.push(
      `sampling capped at ${args.maxFrames} frames (raise --max-frames to cover the whole video)`
    );
  }

  const workDir = createPerceptionWorkDir('watch');
  try {
    const sampleDir = path.join(workDir, 'frames');
    safeMkdir(sampleDir, { recursive: true });
    try {
      await deps.runMedia('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        absolute,
        '-vf',
        `fps=1/${every}`,
        '-frames:v',
        String(args.maxFrames),
        path.join(sampleDir, 'frame-%04d.png'),
      ]);
    } catch (error) {
      explainMediaError('watch', error);
    }
    const frameFiles = safeReaddir(sampleDir)
      .filter((name) => /^frame-\d{4}\.png$/.test(name))
      .sort();
    if (frameFiles.length === 0) warnings.push('ffmpeg produced no frames');
    if (framesDir) safeMkdir(framesDir, { recursive: true });

    const frames: WatchFrame[] = [];
    let ocrFailure: string | undefined;
    for (const [index, name] of frameFiles.entries()) {
      const source = path.join(sampleDir, name);
      const frame: WatchFrame = { time_sec: Math.round(index * every * 10) / 10 };
      if (framesDir) {
        const kept = path.join(framesDir, name);
        safeCopyFileSync(source, kept);
        frame.path = path.relative(pathResolver.rootDir(), kept);
      }
      if (args.ocr && !ocrFailure) {
        try {
          const ocr = await deps.ocr({
            path: path.relative(pathResolver.rootDir(), source),
            mode: 'local_only',
            ...(args.lang ? { language: args.lang } : {}),
          });
          frame.text = ocr.text;
        } catch (error) {
          ocrFailure = (error as Error).message;
          warnings.push(`local OCR unavailable, frames not read: ${ocrFailure}`);
        }
      }
      frames.push(frame);
    }
    const timeline = args.ocr ? dropDuplicateFrames(frames) : frames;
    if (timeline.length < frames.length) {
      warnings.push(
        `${frames.length - timeline.length} near-duplicate frame(s) omitted from the timeline`
      );
    }

    let transcript: WatchResult['transcript'];
    if (!args.audio) {
      // explicitly skipped
    } else if (!metadata.has_audio) {
      warnings.push('video has no audio stream; no transcript');
    } else {
      try {
        const heard = await transcribeMediaFile(deps, 'watch', absolute, workDir, {
          ...(args.lang ? { language: args.lang } : {}),
          timestamps: true,
        });
        transcript = {
          backend: heard.backend,
          ...(heard.language ? { language: heard.language } : {}),
          text: heard.text,
          ...(heard.segments ? { segments: heard.segments } : {}),
        };
        warnings.push(...heard.warnings.filter((w) => !w.includes('returned no timestamps')));
      } catch (error) {
        if (!(error instanceof NoTranscriptError)) throw error;
        warnings.push(`no transcript: ${error.message}`);
      }
    }

    const result: WatchResult = {
      file: path.relative(pathResolver.rootDir(), absolute),
      metadata,
      every_sec: every,
      ...(transcript ? { transcript } : {}),
      frames: timeline,
      warnings,
    };
    if (framesDir) warnings.push(`${frameFiles.length} frame(s) kept in ${args.frames}`);
    emitOutput(
      'watch',
      renderWatchResult(result, args.json),
      args.out,
      print,
      `${timeline.length} frame(s)${transcript ? ', transcript' : ''}`
    );
    return result;
  } finally {
    removeWorkDir(workDir);
  }
}
