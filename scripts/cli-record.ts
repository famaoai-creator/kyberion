/**
 * `pnpm kyberion record screen|audio [--duration <s>] [--out <file>] [--device <name>] [--json]`
 *
 * The time-series counterpart of `pnpm kyberion capture`: recording through
 * the governed system-actuator (`record_screen` / `record_audio`) — no
 * recording code of its own. Frame redaction (screen) stays inside the actuator.
 *
 * Invocation follows the pipeline-steps form
 * (`{action:'pipeline', steps:[{type:'capture', op, params}]}`) — the only
 * form the system-actuator executes. Stdout carries the summary (or --json).
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeStat } from '@agent/core/secure-io';
import { ScriptExitError } from './lib/harness.js';
import { isInsideRepository, parseCommonOption } from './lib/perception.js';

export const RECORD_USAGE = `Usage: pnpm kyberion record screen|audio|camera [--duration <seconds>] [--out <file>] [--device <name>] [--json]

Records a time-series capture through the governed recording bridges.
  record screen      Record the screen as video via system:record_screen (frames redacted, max 300s)
  record audio       Record microphone audio via system:record_audio (meetings: pnpm minutes:record)
  record camera      Record camera video via system:record_camera (photo-per-frame, low fps, max 60s)
  --duration <s>     Seconds to record (default 5; screen/audio max 300, camera max 60)
  --out <file>       Where to write inside the repository.
                     screen/camera: mp4 / mov (defaults under active/shared/runtime/computer/)
                     audio: a single wav / mp3 / m4a / ... file (needs exactly one input),
                            or omit to record every input into the governed audio store
  --device <name>    Audio input to record (default: every available input)
  --json             Print {out, bytes, duration_s, source, files?, warnings} as JSON
  --verbose          Keep runtime logs (off by default)

Play video back, then transcribe with \`pnpm kyberion watch <video>\` / \`pnpm kyberion listen <audio>\`.`;

export const RECORD_VIDEO_EXTENSIONS = ['.mp4', '.mov'] as const;
export const RECORD_AUDIO_EXTENSIONS = [
  '.wav',
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.opus',
] as const;
export const RECORD_DEFAULT_DURATION_S = 5;
export const RECORD_MAX_DURATION_S = 300;
export const RECORD_CAMERA_MAX_DURATION_S = 60;

export interface RecordArgs {
  json: boolean;
  help: boolean;
  out?: string;
  device?: string;
  source: 'screen' | 'audio' | 'camera';
  durationS: number;
}

export interface RecordResult {
  out: string;
  bytes: number;
  duration_s: number;
  source: string;
  files?: string[];
  warnings: string[];
}

/** Everything that touches the OS goes through here so the command stays hermetically testable. */
export interface RecordDeps {
  record(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function buildRecordScreenPipelineInput(
  target: string,
  durationS: number
): Record<string, unknown> {
  return {
    action: 'pipeline',
    steps: [
      {
        type: 'capture',
        op: 'record_screen',
        params: {
          capture_mode: 'screen',
          duration: durationS,
          output: target,
          export_as: 'screen_recording',
        },
      },
    ],
  };
}

export function buildRecordAudioPipelineInput(options: {
  durationS: number;
  output?: string;
  device?: string;
}): Record<string, unknown> {
  return {
    action: 'pipeline',
    steps: [
      {
        type: 'capture',
        op: 'record_audio',
        params: {
          duration: options.durationS,
          ...(options.output ? { output: options.output } : {}),
          ...(options.device ? { targets: [options.device] } : {}),
          export_as: 'audio_recording',
        },
      },
    ],
  };
}

export function buildRecordCameraPipelineInput(
  target: string,
  durationS: number
): Record<string, unknown> {
  return {
    action: 'pipeline',
    steps: [
      {
        type: 'capture',
        op: 'record_camera',
        params: { duration: durationS, output: target, export_as: 'camera_recording' },
      },
    ],
  };
}

export const defaultRecordDeps: RecordDeps = {
  async record(input) {
    const { handleAction } = await import('../libs/actuators/system-actuator/src/index.js');
    return (await handleAction(input as never)) as Record<string, unknown>;
  },
};

function parseRecordArgs(argv: string[]): RecordArgs {
  const args: RecordArgs = {
    json: false,
    help: false,
    source: 'screen',
    durationS: RECORD_DEFAULT_DURATION_S,
  };
  const common: { json: boolean; help: boolean; out?: string } = { json: false, help: false };
  const takeValue = (index: number, flag: string, label: string): string => {
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new ScriptExitError(1, `${flag} requires ${label}`);
    return next;
  };
  let sourceSeen: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    const commonRes = parseCommonOption(common, argv, index);
    if (commonRes) {
      index += commonRes.consumed;
      continue;
    }
    if (value === '--screen' || value === '--audio' || value === '--camera') {
      const source = value.slice(2);
      if (sourceSeen && sourceSeen !== source) {
        throw new ScriptExitError(1, '[record] pass one of --screen, --audio, --camera');
      }
      sourceSeen = source;
      args.source = source as RecordArgs['source'];
    } else if (value === '--device') {
      args.device = takeValue(index, '--device', 'an audio input name');
      index += 1;
    } else if (value === '--duration') {
      const raw = takeValue(index, '--duration', 'seconds');
      const parsed = Number(raw);
      const maxS = args.source === 'camera' ? RECORD_CAMERA_MAX_DURATION_S : RECORD_MAX_DURATION_S;
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maxS) {
        throw new ScriptExitError(1, `--duration must be 1-${maxS} seconds, got "${raw}"`);
      }
      args.durationS = parsed;
      index += 1;
    } else if (value.startsWith('--')) throw new ScriptExitError(1, `Unknown option: ${value}`);
    else throw new ScriptExitError(1, `Unexpected argument: ${value}`);
  }
  args.json = common.json;
  args.help = common.help;
  args.out = common.out;
  return args;
}

function resolveRecordVideoOut(out: string | undefined, source: 'screen' | 'camera'): string {
  const stem = source === 'camera' ? 'camera-recording' : 'screen-recording';
  const candidate = out ?? path.join('active/shared/runtime/computer', `${stem}-${Date.now()}.mp4`);
  const target = pathResolver.rootResolve(candidate);
  if (!isInsideRepository(target)) {
    throw new ScriptExitError(1, `[record] --out ${candidate} must be inside the repository`);
  }
  const ext = path.extname(target).toLowerCase();
  if (!(RECORD_VIDEO_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new ScriptExitError(
      1,
      `[record] unsupported file type "${ext || '(none)'}". Supported: ${RECORD_VIDEO_EXTENSIONS.join(', ')}.`
    );
  }
  return target;
}

function resolveRecordAudioOut(out: string | undefined): string | undefined {
  if (!out) return undefined;
  const target = pathResolver.rootResolve(out);
  if (!isInsideRepository(target)) {
    throw new ScriptExitError(1, `[record] --out ${out} must be inside the repository`);
  }
  const ext = path.extname(target).toLowerCase();
  if (!(RECORD_AUDIO_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new ScriptExitError(
      1,
      `[record] unsupported file type "${ext || '(none)'}". Supported: ${RECORD_AUDIO_EXTENSIONS.join(', ')}.`
    );
  }
  return target;
}

export function renderRecordResult(result: RecordResult, asJson: boolean): string {
  if (asJson) return JSON.stringify(result, null, 2);
  const lines =
    result.files && result.files.length > 1
      ? [
          `[record] wrote ${result.files.length} audio files under ${result.out} (${result.bytes} bytes, ~${result.duration_s}s)`,
        ]
      : [
          `[record] wrote ${result.out} (${result.bytes} bytes, ~${result.duration_s}s, ${result.source})`,
        ];
  lines.push(...result.warnings.map((w) => `> [record] ${w}`));
  return lines.join('\n');
}

interface AudioRecordingEntry {
  device_name: string;
  status: string;
  recorded_path: string;
  error?: string;
}

function toRelative(repoPath: string): string {
  return path.relative(pathResolver.rootDir(), repoPath);
}

function statSizeOrThrow(saved: string, opName: string): number {
  try {
    return safeStat(saved).size;
  } catch {
    throw new ScriptExitError(
      1,
      `[record] system:${opName} reported success but ${toRelative(saved)} is unreadable`
    );
  }
}

export async function runRecordCommand(
  argv: string[],
  print: (text: string) => void,
  deps: RecordDeps = defaultRecordDeps
): Promise<RecordResult | undefined> {
  const args = parseRecordArgs(argv);
  if (args.help) {
    print(RECORD_USAGE);
    return undefined;
  }
  if (args.device && args.source !== 'audio') {
    throw new ScriptExitError(1, '[record] --device only applies to `record audio`');
  }
  if (args.source === 'camera' && args.durationS > RECORD_CAMERA_MAX_DURATION_S) {
    throw new ScriptExitError(
      1,
      `--duration must be 1-${RECORD_CAMERA_MAX_DURATION_S} seconds for camera, got "${args.durationS}"`
    );
  }
  if (args.source === 'screen' || args.source === 'camera') {
    const opName = args.source === 'camera' ? 'record_camera' : 'record_screen';
    const target = resolveRecordVideoOut(args.out, args.source);
    const input =
      args.source === 'camera'
        ? buildRecordCameraPipelineInput(target, args.durationS)
        : buildRecordScreenPipelineInput(target, args.durationS);
    let raw: Record<string, unknown>;
    try {
      raw = await deps.record(input);
    } catch (error) {
      throw new ScriptExitError(1, `[record] system:${opName} failed: ${(error as Error).message}`);
    }
    const context =
      raw.context && typeof raw.context === 'object'
        ? (raw.context as Record<string, unknown>)
        : raw;
    const key = args.source === 'camera' ? 'camera_recording' : 'screen_recording';
    const nested =
      context[key] && typeof context[key] === 'object'
        ? (context[key] as Record<string, unknown>)
        : undefined;
    const saved =
      (typeof nested?.output_path === 'string' ? nested.output_path : undefined) ??
      (typeof nested?.path === 'string' ? nested.path : undefined) ??
      target;
    const bytes = statSizeOrThrow(saved, opName);
    const result: RecordResult = {
      out: toRelative(saved),
      bytes,
      duration_s: args.durationS,
      source: args.source,
      warnings: [],
    };
    print(renderRecordResult(result, args.json));
    return result;
  }
  const output = resolveRecordAudioOut(args.out);
  let raw: Record<string, unknown>;
  try {
    raw = await deps.record(
      buildRecordAudioPipelineInput({ durationS: args.durationS, output, device: args.device })
    );
  } catch (error) {
    throw new ScriptExitError(
      1,
      `[record] system:record_audio failed: ${(error as Error).message}`
    );
  }
  const context =
    raw.context && typeof raw.context === 'object' ? (raw.context as Record<string, unknown>) : raw;
  const recording =
    context.audio_recording && typeof context.audio_recording === 'object'
      ? (context.audio_recording as Record<string, unknown>)
      : undefined;
  const entries = (Array.isArray(recording?.recordings) ? recording.recordings : []).map(
    (entry) => entry as AudioRecordingEntry
  );
  if (entries.length === 0) {
    throw new ScriptExitError(1, '[record] system:record_audio returned no recordings');
  }
  const failed = entries.filter((entry) => entry.status !== 'recorded');
  if (failed.length > 0) {
    const detail = failed
      .map((entry) => `${entry.device_name}: ${entry.error || entry.status}`)
      .join('; ');
    throw new ScriptExitError(1, `[record] ${failed.length} input(s) failed: ${detail}`);
  }
  if (entries.length === 1) {
    const saved = entries[0]!.recorded_path;
    const result: RecordResult = {
      out: toRelative(saved),
      bytes: statSizeOrThrow(saved, 'record_audio'),
      duration_s: args.durationS,
      source: args.source,
      warnings: [],
    };
    print(renderRecordResult(result, args.json));
    return result;
  }
  const files = entries.map((entry) => toRelative(entry.recorded_path));
  const bytes = entries.reduce(
    (sum, entry) => sum + statSizeOrThrow(entry.recorded_path, 'record_audio'),
    0
  );
  const dir = toRelative(path.dirname(entries[0]!.recorded_path));
  const result: RecordResult = {
    out: dir,
    bytes,
    duration_s: args.durationS,
    source: args.source,
    files,
    warnings: entries.map((entry) => `${entry.device_name} -> ${toRelative(entry.recorded_path)}`),
  };
  print(renderRecordResult(result, args.json));
  return result;
}
