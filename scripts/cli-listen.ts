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
import type { TranscriptSegment } from '@agent/core/speech-to-text-bridge';
import { ScriptExitError } from './lib/harness.js';
import {
  assertExtension,
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
  transcribeWav,
  VIDEO_EXTENSIONS,
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

Videos: use \`pnpm kyberion watch <video>\`. No backend yet? Run \`pnpm kyberion voice setup\`.
The file must be inside the repository. Copy external files first, e.g.
  mkdir -p active/shared/tmp/<job> && cp ~/Downloads/<audio> active/shared/tmp/<job>/`;

interface ListenArgs extends CommonArgs {
  timestamps: boolean;
}

export interface ListenResult {
  file: string;
  backend: string;
  language?: string;
  text: string;
  segments?: TranscriptSegment[];
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
  options: { language?: string; timestamps: boolean }
): Promise<ListenResult> {
  const wav = path.join(workDir, 'audio-16k-mono.wav');
  try {
    await extractSttWav(deps, absolute, wav);
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
  const absolute = resolveRepositoryInput('listen', args.file);
  const ext = path.extname(absolute).toLowerCase();
  if (ext !== '.webm' && (VIDEO_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new ScriptExitError(
      1,
      `[listen] ${args.file} is a video. Use \`pnpm kyberion watch ${args.file}\` (transcript + frames).`
    );
  }
  assertExtension('listen', absolute, AUDIO_EXTENSIONS);
  const workDir = createPerceptionWorkDir('listen');
  try {
    const result = await transcribeMediaFile(deps, 'listen', absolute, workDir, {
      ...(args.lang ? { language: args.lang } : {}),
      timestamps: args.timestamps,
    });
    emitOutput(
      'listen',
      renderListenResult(result, { json: args.json, timestamps: args.timestamps }),
      args.out,
      print,
      `${result.backend}, ${result.text.length} chars`
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
