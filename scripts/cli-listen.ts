import type { Observation } from '@agent/core/perception/observation';
import {
  PERCEPTION_OPTIONS_HELP,
  validatePerceptionOptions,
  enhancementDeps,
  renderObservations,
} from './lib/perception-enhancements.js';
/**
 * `pnpm kyberion listen <audio> [--lang <bcp47>] [--timestamps] [--json] [--out <file>]`
 *
 * Transcribes a recording through the governed speech-to-text bridge
 * (@agent/core/speech-to-text-bridge). The input is first normalized to the
 * STT-ready shape (16 kHz mono PCM wav) in a unique shared-tmp scratch dir,
 * which is removed afterwards — nothing is written next to the input.
 *
 * The stub bridge / synthetic sidecar transcripts are refused: when no real
 * backend is installed the command fails and points to `kyberion voice setup`.
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { resolvePerceptionScope } from '@agent/core/perception/observation';
import type { TranscriptSegment } from '@agent/core/voice/speech-to-text-bridge';
import { ScriptExitError } from './lib/harness.js';
import {
  assertExtension,
  assertPerceptionInput,
  assertAudioAnalysisDuration,
  AUDIO_EXTENSIONS,
  createPerceptionWorkDir,
  defaultPerceptionDeps,
  emitOutput,
  explainMediaError,
  extractSttWav,
  NoTranscriptError,
  parseCommonOption,
  removeWorkDir,
  renderSegments,
  resolveRepositoryInput,
  sniffMediaSignature,
  transcribeWav,
  VIDEO_EXTENSIONS,
  withPerceptionMediaRole,
  type CommonArgs,
  type PerceptionDeps,
} from './lib/perception.js';

export const LISTEN_USAGE = `Usage: pnpm kyberion listen <audio> [--lang <bcp47>] [--timestamps] [--json] [--out <file>]

Transcribes a ${AUDIO_EXTENSIONS.join(' / ')} recording with the installed local speech-to-text backend.
  --lang <tag>    Spoken language, e.g. ja, en (auto / locale default when omitted)
  --timestamps    Render segments as [mm:ss–mm:ss] text (prefers a timestamp-capable backend)
  --json          Print {file, backend, language, text, segments, warnings} as JSON
  --out <file>    Write the Markdown (or JSON) to a file inside the repository instead of stdout
  --verbose       Keep runtime logs (they go to stdout; off by default so stdout is the content)

${PERCEPTION_OPTIONS_HELP}

Videos: use \`pnpm kyberion watch <video>\`. No backend yet? Run \`pnpm kyberion voice setup\`.
The file must be inside the repository. Copy external files first, e.g.
  mkdir -p active/shared/tmp/<job> && cp ~/Downloads/<audio> active/shared/tmp/<job>/`;

interface ListenArgs extends CommonArgs {
  timestamps: boolean;
}

export interface ListenResult {
  source?: import('@agent/core/perception/observation').PerceptionSource;
  file: string;
  backend: string;
  language?: string;
  text: string;
  segments?: (TranscriptSegment & { speaker_id?: string })[];
  analysis?: import('@agent/core/perception/audio-analysis').AudioAnalysisResult;
  observations?: Observation[];
  warnings: string[];
}

function parseListenArgs(argv: string[]): ListenArgs {
  const args: ListenArgs = { json: false, help: false, timestamps: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    const common = parseCommonOption(args, argv, index);
    if (common) {
      index += common.consumed;
      continue;
    }
    if (value === '--timestamps') args.timestamps = true;
    else if (value.startsWith('--')) throw new ScriptExitError(1, `Unknown option: ${value}`);
    else if (!args.file) args.file = value;
    else throw new ScriptExitError(1, `Unexpected argument: ${value}`);
  }
  return args;
}

export function renderListenResult(
  result: ListenResult,
  options: { json: boolean; timestamps: boolean }
): string {
  if (options.json) return JSON.stringify(result, null, 2);
  const body =
    options.timestamps && result.segments && result.segments.length > 0
      ? renderSegments(result.segments)
      : result.text.trim() || '_(no speech recognized)_';
  const lines = [
    `# ${path.basename(result.file)}`,
    '',
    `- file: ${result.file}`,
    `- backend: ${result.backend}${result.language ? ` (language ${result.language})` : ''}`,
    '',
    '## Transcript',
    '',
    body,
  ];
  if (result.analysis)
    lines.push('', '## Audio analysis', '', JSON.stringify(result.analysis, null, 2));
  if (result.observations) lines.push(...renderObservations(result.observations));
  if (result.warnings.length > 0) lines.push('', ...result.warnings.map((w) => `> [listen] ${w}`));
  return lines.join('\n');
}

/**
 * Normalize + transcribe an audio (or video audio track) into a ListenResult.
 * Shared with `watch`. Throws NoTranscriptError when no real backend works.
 */
export async function transcribeMediaFile(
  deps: PerceptionDeps,
  command: string,
  absolute: string,
  workDir: string,
  options: { language?: string; timestamps: boolean; maxSeconds?: number }
): Promise<ListenResult> {
  const wav = path.join(workDir, 'audio-16k-mono.wav');
  // R04: prove the input is real media by signature before ffmpeg — a renamed
  // text file must report input_invalid, not raw ffmpeg stderr. The sniff is a
  // guarded read of the input the user pointed at: on a protected tier the
  // interactive identity performs it under the tenant-bound media role.
  const inputScope = resolvePerceptionScope(absolute);
  const isMedia = await withPerceptionMediaRole(inputScope, () => sniffMediaSignature(absolute));
  if (!isMedia) {
    throw new ScriptExitError(
      1,
      `[${command}] input_invalid: ${path.basename(absolute)} is not recognizable media (bad or missing container signature) | next: supply a real audio/video file`
    );
  }
  try {
    await extractSttWav(deps, absolute, wav, options.maxSeconds);
    if (options.maxSeconds !== undefined) await assertAudioAnalysisDuration(deps, wav);
  } catch (error) {
    explainMediaError(command, error);
  }
  const { result, errors } = await transcribeWav(deps, wav, workDir, {
    ...(options.language ? { language: options.language } : {}),
    preferTimestamps: options.timestamps,
  });
  const warnings = errors.map((error) => `skipped backend ${error}`);
  if (options.timestamps && !(result.segments && result.segments.length > 0)) {
    warnings.push(`backend ${result.backend} returned no timestamps; printing plain text`);
  }
  return {
    file: path.relative(pathResolver.rootDir(), absolute),
    backend: result.backend,
    ...(result.language ? { language: result.language } : {}),
    text: result.text,
    ...(result.segments && result.segments.length > 0 ? { segments: result.segments } : {}),
    warnings,
  };
}

export async function runListenCommand(
  argv: string[],
  print: (text: string) => void,
  deps: PerceptionDeps = defaultPerceptionDeps
): Promise<ListenResult | undefined> {
  const args = parseListenArgs(argv);
  if (args.help || !args.file) {
    if (!args.file && !args.help) throw new ScriptExitError(1, LISTEN_USAGE);
    print(LISTEN_USAGE);
    return undefined;
  }
  const options = args.enhancement ?? {};
  validatePerceptionOptions('listen', options);
  const absolute = resolveRepositoryInput('listen', args.file);
  const ext = path.extname(absolute).toLowerCase();
  if (ext !== '.webm' && (VIDEO_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new ScriptExitError(
      1,
      `[listen] ${args.file} is a video. Use \`pnpm kyberion watch ${args.file}\` (transcript + frames).`
    );
  }
  assertExtension('listen', absolute, AUDIO_EXTENSIONS);
  // The input read and every guarded read of the scratch below run under the
  // tenant-bound media role on protected tiers (see withPerceptionMediaRole).
  const inputScope = resolvePerceptionScope(absolute);
  await withPerceptionMediaRole(inputScope, () => assertPerceptionInput(absolute));
  const workDir = createPerceptionWorkDir('listen', absolute);
  try {
    const feature =
      options.grounded || options.diarize || options.events
        ? await enhancementDeps(deps)
        : undefined;
    const source = feature
      ? await withPerceptionMediaRole(
          inputScope,
          () => feature.source?.(absolute) ?? feature.perceptionSource(absolute)
        )
      : undefined;
    if (options.diarize || options.events) await assertAudioAnalysisDuration(deps, absolute);
    const result: ListenResult = options.noTranscript
      ? {
          file: path.relative(pathResolver.rootDir(), absolute),
          backend: 'analysis-only',
          text: '',
          warnings: [],
        }
      : await transcribeMediaFile(deps, 'listen', absolute, workDir, {
          ...(args.lang ? { language: args.lang } : {}),
          timestamps: args.timestamps || Boolean(options.diarize),
          ...(options.diarize || options.events ? { maxSeconds: 601 } : {}),
        });
    if (source && feature) {
      result.source = source;
      result.observations = [];
      if (options.diarize || options.events) {
        const wav = path.join(workDir, 'analysis-16k-mono.wav');
        await extractSttWav(deps, absolute, wav, 601);
        const audio = await import('@agent/core/perception/audio-analysis');
        result.analysis = await withPerceptionMediaRole(inputScope, () =>
          (deps.enhancements?.analyzeAudio ?? audio.analyzeAudio)({
            path: wav,
            diarize: options.diarize,
            events: options.events,
            diarizationModel: options.diarizationModel,
            audioModel: options.audioModel,
            python: options.python,
          })
        );
        result.warnings.push(...result.analysis.warnings);
        if (options.diarize && result.segments)
          result.segments = (deps.enhancements?.alignSpeakers ?? audio.alignSpeakerSegments)(
            result.segments,
            result.analysis.speakers
          );
        else if (options.diarize && !options.noTranscript)
          result.warnings.push(
            'transcript has no segment timestamps; speaker labels are available separately, not aligned to text'
          );
        for (const speaker of result.analysis.speakers)
          result.observations.push(
            feature.observation(source, {
              modality: 'audio',
              kind: 'speaker',
              provider: result.analysis.provider,
              finality: 'tentative',
              speaker_id: speaker.speaker_id,
              time: { start_sec: speaker.start_sec, end_sec: speaker.end_sec, basis: 'aligned' },
              ...(speaker.confidence === undefined ? {} : { confidence: speaker.confidence }),
            })
          );
        for (const event of result.analysis.events)
          result.observations.push(
            feature.observation(source, {
              modality: 'audio',
              kind: 'sound_event',
              provider: result.analysis.provider,
              finality: 'final',
              text: event.label,
              confidence: event.confidence,
              time: { start_sec: event.start_sec, end_sec: event.end_sec, basis: 'aligned' },
            })
          );
      }
      if (result.segments)
        result.observations.push(
          ...feature.transcriptObservations(source, result.backend, result.segments)
        );
      else if (result.text)
        result.observations.push(
          feature.observation(source, {
            modality: 'audio',
            kind: 'speech',
            provider: result.backend,
            finality: 'final',
            text: result.text,
          })
        );
    }
    if (source && feature)
      await withPerceptionMediaRole(inputScope, () => feature.assertSourceUnchanged(source));
    emitOutput(
      'listen',
      renderListenResult(result, { json: args.json, timestamps: args.timestamps }),
      args.out,
      print,
      `${result.backend}, ${result.text.length} chars`,
      absolute
    );
    return result;
  } catch (error) {
    if (error instanceof NoTranscriptError)
      throw new ScriptExitError(1, `[listen] ${error.message}`);
    throw error;
  } finally {
    removeWorkDir(workDir);
  }
}
