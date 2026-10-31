import type { Observation } from '@agent/core/perception/observation';
import type { VisualFingerprint, VisualChange } from '@agent/core/perception/visual-change';
import {
  PERCEPTION_OPTIONS_HELP,
  validatePerceptionOptions,
  enhancementDeps,
  renderObservations,
} from './lib/perception-enhancements.js';
/**
 * `pnpm kyberion watch <video> [--every <sec>] [--max-frames <n>] [--no-ocr]
 *   [--no-audio] [--ocr-provider <id>] [--frames <dir>] [--lang <bcp47>] [--json] [--out <file>]`
 *
 * Perceives a video the way `read` perceives a document: ffprobe for the
 * metadata, a sampled frame timeline OCR'd locally (same path as `see`), and
 * the audio track transcribed by the same code as `listen`. Media work runs
 * through the platform media runner; scratch lives in a unique shared-tmp
 * dir that is removed afterwards (frames are copied out only with --frames).
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { resolvePerceptionScope } from '@agent/core/perception/observation';
import { safeMkdir, safeReaddir, safeReadFile, safeWriteFile } from '@agent/core/secure-io';
import type { TranscriptSegment } from '@agent/core/voice/speech-to-text-bridge';
import { ScriptExitError } from './lib/harness.js';
import { transcribeMediaFile } from './cli-listen.js';
import {
  assertExtension,
  assertPerceptionInput,
  assertPerceptionOutput,
  createPerceptionWorkDir,
  defaultPerceptionDeps,
  emitOutput,
  explainMediaError,
  extractSttWav,
  formatTimestamp,
  isInsideRepository,
  NoTranscriptError,
  parseCommonOption,
  removeWorkDir,
  renderSegments,
  resolveRepositoryInput,
  VIDEO_EXTENSIONS,
  LOCAL_MEDIA_INPUT_ARGS,
  withPerceptionMediaRole,
  type CommonArgs,
  type PerceptionDeps,
} from './lib/perception.js';

const DEFAULT_MAX_FRAMES = 24;

export const WATCH_USAGE = `Usage: pnpm kyberion watch <video> [--every <sec>] [--max-frames <n>] [--no-ocr] [--no-audio] [--ocr-provider <id>] [--frames <dir>] [--lang <bcp47>] [--json] [--out <file>]

Perceives a ${VIDEO_EXTENSIONS.join(' / ')} video: metadata, audio transcript, and an OCR'd frame timeline (local only).
  --every <sec>     Sample one frame every <sec> seconds (default: spread --max-frames over the duration)
  --max-frames <n>  Upper bound on sampled frames (default ${DEFAULT_MAX_FRAMES})
  --no-ocr          Skip frame OCR (timeline lists timestamps only)
  --no-audio        Skip the audio transcript
  --ocr-provider <id> Prefer an OCR provider (e.g. local_vlm); allows loopback OCR, never external OCR
  --frames <dir>    Keep the sampled frames as PNGs in <dir> (inside the repository)
  --lang <tag>      Language hint for OCR and speech, e.g. ja, en
  --json            Print {file, metadata, transcript, frames, warnings} as JSON
  --out <file>      Write the Markdown (or JSON) to a file inside the repository instead of stdout
  --verbose         Keep runtime logs (they go to stdout; off by default so stdout is the content)

${PERCEPTION_OPTIONS_HELP}

Needs ffmpeg (macOS: brew install ffmpeg). The file must be inside the repository. Copy external files first, e.g.
  mkdir -p active/shared/tmp/<job> && cp ~/Downloads/<video> active/shared/tmp/<job>/`;

interface WatchArgs extends CommonArgs {
  every?: number;
  maxFrames: number;
  ocr: boolean;
  audio: boolean;
  frames?: string;
  ocrProvider?: string;
}

export interface VideoMetadata {
  duration_sec: number;
  width?: number;
  height?: number;
  video_codec?: string;
  has_audio: boolean;
}

export interface WatchFrame {
  change?: VisualChange;
  ocr_provider?: string;
  time_sec: number;
  text?: string;
  path?: string;
}

export interface WatchResult {
  source?: import('@agent/core/perception/observation').PerceptionSource;
  observations?: Observation[];
  analysis?: import('@agent/core/perception/audio-analysis').AudioAnalysisResult;
  tracking?: import('@agent/core/perception/tracking').TrackingResult;
  animation_cues?: unknown[];
  index?: unknown;
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
      if (args.maxFrames > 300) throw new ScriptExitError(1, '--max-frames must be at most 300');
      index += 1;
    } else if (value === '--frames') {
      args.frames = argv[index + 1];
      index += 1;
      if (!args.frames) throw new ScriptExitError(1, '--frames requires a directory');
    } else if (value === '--ocr-provider') {
      args.ocrProvider = argv[index + 1];
      index += 1;
      if (!args.ocrProvider) throw new ScriptExitError(1, '--ocr-provider requires an id');
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
  if (result.analysis)
    lines.push('', '## Audio analysis', '', JSON.stringify(result.analysis, null, 2));
  if (result.tracking) lines.push('', '## Tracking', '', JSON.stringify(result.tracking));
  if (result.index) lines.push('', '## Index', '', JSON.stringify(result.index));
  if (result.observations) lines.push(...renderObservations(result.observations));
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
  const options = args.enhancement ?? {};
  validatePerceptionOptions('watch', options);
  if (!args.audio && (options.diarize || options.events))
    throw new ScriptExitError(1, '--no-audio cannot be combined with audio analysis');
  const absolute = resolveRepositoryInput('watch', args.file);
  assertExtension(
    'watch',
    absolute,
    VIDEO_EXTENSIONS,
    'Audio-only files: use `pnpm kyberion listen`.'
  );
  // The input read and every guarded read of the perception scratch below
  // (frame listing, frame OCR/fingerprints, audio analysis, source hashes)
  // run under the tenant-bound media role on protected tiers (see
  // withPerceptionMediaRole).
  const inputScope = resolvePerceptionScope(absolute);
  await withPerceptionMediaRole(inputScope, () => assertPerceptionInput(absolute));
  const framesDir = args.frames ? pathResolver.rootResolve(args.frames) : undefined;
  if (framesDir && !isInsideRepository(framesDir)) {
    throw new ScriptExitError(
      1,
      `[watch] --frames ${args.frames} must be a directory inside the repository`
    );
  }

  if (framesDir) assertPerceptionOutput(absolute, path.join(framesDir, 'frame.png'));
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
        ...LOCAL_MEDIA_INPUT_ARGS,
        absolute,
      ])
    );
  } catch (error) {
    explainMediaError('watch', error);
  }

  if (
    ![metadata.width, metadata.height].every(
      (value) =>
        typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ) ||
    metadata.width! * metadata.height! > 16_000_000
  )
    throw new ScriptExitError(
      1,
      '[watch] decoded video dimensions must be known and <=16 million pixels'
    );
  if (
    (options.events || options.diarize) &&
    (!Number.isFinite(metadata.duration_sec) ||
      metadata.duration_sec <= 0 ||
      metadata.duration_sec > 600)
  )
    throw new ScriptExitError(1, '[watch] audio analysis is limited to 600 seconds');
  const enhanced = Boolean(
    options.grounded ||
    options.changes ||
    options.track ||
    options.diarize ||
    options.events ||
    options.index
  );
  const feature = enhanced ? await enhancementDeps(deps) : undefined;
  const source = feature
    ? await withPerceptionMediaRole(
        inputScope,
        () => feature.source?.(absolute) ?? feature.perceptionSource(absolute)
      )
    : undefined;
  const observations: Observation[] = [];
  const warnings: string[] = [];
  const duration = metadata.duration_sec > 0 ? metadata.duration_sec : 1;
  const every = args.every ?? Math.max(1, Math.ceil((duration / args.maxFrames) * 10) / 10);
  const wanted = Math.floor(duration / every) + 1;
  if (wanted > args.maxFrames) {
    warnings.push(
      `sampling capped at ${args.maxFrames} frames (raise --max-frames to cover the whole video)`
    );
  }

  const workDir = createPerceptionWorkDir('watch', absolute);
  try {
    const sampleDir = path.join(workDir, 'frames');
    safeMkdir(sampleDir, { recursive: true });
    try {
      await deps.runMedia('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        ...LOCAL_MEDIA_INPUT_ARGS,
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
    const frameFiles = (await withPerceptionMediaRole(inputScope, () => safeReaddir(sampleDir)))
      .filter((name) => /^frame-\d{4}\.png$/.test(name))
      .sort();
    if (frameFiles.length === 0) warnings.push('ffmpeg produced no frames');
    if (framesDir) safeMkdir(framesDir, { recursive: true });

    const frames: WatchFrame[] = [];
    let ocrFailure: string | undefined;
    let priorFingerprint: VisualFingerprint | undefined;
    for (const [index, name] of frameFiles.entries()) {
      const source = path.join(sampleDir, name);
      const frame: WatchFrame = { time_sec: Math.round(index * every * 10) / 10 };
      if (framesDir) {
        const kept = path.join(framesDir, name);
        // The scratch read needs the media role on protected tiers; the
        // --frames destination write stays under the caller's own identity so
        // it keeps working wherever the caller may already write.
        const bytes = (await withPerceptionMediaRole(inputScope, () =>
          safeReadFile(source, { encoding: null })
        )) as Buffer;
        safeWriteFile(kept, bytes);
        frame.path = path.relative(pathResolver.rootDir(), kept);
      }
      if (args.ocr && !ocrFailure) {
        try {
          const ocr = await withPerceptionMediaRole(inputScope, () =>
            deps.ocr({
              path: path.relative(pathResolver.rootDir(), source),
              mode: args.ocrProvider ? 'privacy_first' : 'local_only',
              ...(args.ocrProvider ? { providerPreference: [args.ocrProvider] } : {}),
              ...(args.lang ? { language: args.lang } : {}),
            })
          );
          frame.text = ocr.text;
          frame.ocr_provider = ocr.provider;
        } catch (error) {
          ocrFailure = (error as Error).message;
          warnings.push(`local OCR unavailable, frames not read: ${ocrFailure}`);
        }
      }
      if (options.changes && feature) {
        const current = await withPerceptionMediaRole(inputScope, () =>
          feature.fingerprint(source)
        );
        if (priorFingerprint) frame.change = feature.compare(priorFingerprint, current);
        if (!priorFingerprint || frame.change?.changed) priorFingerprint = current;
      }
      frames.push(frame);
    }
    const timeline = options.changes
      ? frames.filter((frame, index) => index === 0 || frame.change?.changed)
      : args.ocr
        ? dropDuplicateFrames(frames)
        : frames;
    if (source && feature) {
      for (const frame of timeline) {
        if (frame.text !== undefined)
          observations.push(
            feature.observation(source, {
              modality: 'video',
              kind: 'text',
              provider: frame.ocr_provider ?? 'unavailable',
              finality: 'final',
              text: frame.text,
              time: { start_sec: frame.time_sec, end_sec: frame.time_sec, basis: 'sampled' },
            })
          );
        if (frame.change)
          observations.push(
            feature.observation(source, {
              modality: 'video',
              kind: 'visual_change',
              provider: 'local-pixel-delta',
              finality: 'final',
              time: { start_sec: frame.time_sec, end_sec: frame.time_sec, basis: 'sampled' },
              attributes: { ...frame.change },
            })
          );
      }
    }
    if (timeline.length < frames.length) {
      warnings.push(
        `${frames.length - timeline.length} near-duplicate frame(s) omitted from the timeline`
      );
    }

    let transcript: WatchResult['transcript'];
    if (!args.audio || options.noTranscript) {
      // explicitly skipped
    } else if (!metadata.has_audio) {
      warnings.push('video has no audio stream; no transcript');
    } else {
      try {
        const heard = await transcribeMediaFile(deps, 'watch', absolute, workDir, {
          ...(args.lang ? { language: args.lang } : {}),
          timestamps: true,
          ...(options.diarize || options.events ? { maxSeconds: 601 } : {}),
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

    let analysis: WatchResult['analysis'];
    if (options.diarize || options.events) {
      if (!metadata.has_audio)
        throw new ScriptExitError(1, '[watch] requested audio analysis but video has no audio');
      const wav = path.join(workDir, 'analysis-16k-mono.wav');
      await extractSttWav(deps, absolute, wav, 601);
      const audio = await import('@agent/core/perception/audio-analysis');
      analysis = await withPerceptionMediaRole(inputScope, () =>
        (deps.enhancements?.analyzeAudio ?? audio.analyzeAudio)({
          path: wav,
          diarize: options.diarize,
          events: options.events,
          diarizationModel: options.diarizationModel,
          audioModel: options.audioModel,
          python: options.python,
        })
      );
      warnings.push(...analysis.warnings);
      if (options.diarize && transcript?.segments)
        transcript.segments = (deps.enhancements?.alignSpeakers ?? audio.alignSpeakerSegments)(
          transcript.segments,
          analysis.speakers
        );
      if (source && feature) {
        for (const speaker of analysis.speakers)
          observations.push(
            feature.observation(source, {
              modality: 'audio',
              kind: 'speaker',
              provider: analysis.provider,
              finality: 'tentative',
              speaker_id: speaker.speaker_id,
              time: { start_sec: speaker.start_sec, end_sec: speaker.end_sec, basis: 'aligned' },
            })
          );
        for (const event of analysis.events)
          observations.push(
            feature.observation(source, {
              modality: 'audio',
              kind: 'sound_event',
              provider: analysis.provider,
              finality: 'final',
              text: event.label,
              confidence: event.confidence,
              time: { start_sec: event.start_sec, end_sec: event.end_sec, basis: 'aligned' },
            })
          );
      }
    }
    if (source && feature && transcript?.segments)
      observations.push(
        ...feature.transcriptObservations(source, transcript.backend, transcript.segments)
      );
    let tracking: WatchResult['tracking'];
    let animation_cues: unknown[] | undefined;
    if (options.track) {
      const tracker = await import('@agent/core/perception/tracking');
      tracking = await withPerceptionMediaRole(inputScope, () =>
        (deps.enhancements?.track ?? tracker.trackMedia)({
          path: absolute,
          faceModel: options.faceModel,
          poseModel: options.poseModel,
          gestureModel: options.gestureModel,
          python: options.python,
          maxFrames: args.maxFrames,
          everyMs: Math.max(1, Math.round(every * 1000)),
        })
      );
      if (source) observations.push(...tracker.trackingObservations(source, tracking));
      if (options.avatarId)
        animation_cues = tracking.frames.flatMap((frame) =>
          (deps.enhancements?.cues ?? tracker.trackingFrameToAnimationCues)(
            frame,
            options.avatarId!
          )
        );
    }
    // --index runs under the same media role: the semantic index lives on
    // the cache floor's perception subtree, which perception_media_worker
    // grants bound to the scope's own tenant.
    let index: unknown;
    if (options.index && source) {
      const indexMedia =
        deps.enhancements?.index ??
        (await import('@agent/core/perception/semantic-index')).indexMedia;
      index = await withPerceptionMediaRole(inputScope, () =>
        indexMedia({
          indexId: options.index!,
          scope: source.scope,
          modelPath: options.embeddingModel!,
          python: options.python,
          entries: frameFiles.map((name, i) => ({
            id: 'frame-' + i,
            path: absolute,
            image_path: path.join(sampleDir, name),
            time_sec: Math.round(i * every * 10) / 10,
            text: frames[i]?.text || undefined,
          })),
        })
      );
    }
    const result: WatchResult = {
      ...(source ? { source, observations } : {}),
      ...(analysis ? { analysis } : {}),
      ...(tracking ? { tracking } : {}),
      ...(animation_cues ? { animation_cues } : {}),
      ...(index ? { index } : {}),
      file: path.relative(pathResolver.rootDir(), absolute),
      metadata,
      every_sec: every,
      ...(transcript ? { transcript } : {}),
      frames: timeline,
      warnings,
    };
    if (framesDir) warnings.push(`${frameFiles.length} frame(s) kept in ${args.frames}`);
    if (source && feature)
      await withPerceptionMediaRole(inputScope, () => feature.assertSourceUnchanged(source));
    emitOutput(
      'watch',
      renderWatchResult(result, args.json),
      args.out,
      print,
      `${timeline.length} frame(s)${transcript ? ', transcript' : ''}`,
      absolute
    );
    return result;
  } finally {
    removeWorkDir(workDir);
  }
}
