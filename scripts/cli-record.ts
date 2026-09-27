/**
 * `pnpm kyberion record --screen [--duration <s>] [--out <video>] [--json]`
 *
 * The time-series counterpart of `pnpm kyberion capture`: screen recording
 * through the governed system-actuator (`system:record_screen`) — no
 * recording code of its own. Frame redaction stays inside the actuator.
 *
 * P1 covers `--screen` only. `--audio` (P2: generic mic op, not the
 * meeting-oriented `pnpm minutes:record`) and `--camera` (P3) return a
 * governed not-yet with next-step guidance.
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeStat } from '@agent/core/secure-io';
import { ScriptExitError } from './lib/harness.js';
import { isInsideRepository, parseCommonOption } from './lib/perception.js';

export const RECORD_USAGE = `Usage: pnpm kyberion record screen [--duration <seconds>] [--out <video>] [--json]

Records the screen as video through the governed recording bridge (frames redacted).
  --duration <s>     Seconds to record (default 5, max 300)
  --out <file>       Where to write (mp4 / mov) inside the repository
                     Default: active/shared/runtime/computer/screen-recording-<timestamp>.mp4
  --json             Print {out, bytes, duration_s, source, warnings} as JSON
  --verbose          Keep runtime logs (off by default)

Microphone (--audio, P2 generic record_audio; meetings: pnpm minutes:record) and
camera video (P3) register as separate \`record <source>\` commands when their ops land.
Play it back, then transcribe with \`pnpm kyberion watch <video>\`.`;

export const RECORD_OUT_EXTENSIONS = ['.mp4', '.mov'] as const;
export const RECORD_DEFAULT_DURATION_S = 5;
export const RECORD_MAX_DURATION_S = 300;

export interface RecordArgs {
  json: boolean;
  help: boolean;
  out?: string;
  source: 'screen';
  durationS: number;
}

export interface RecordResult {
  out: string;
  bytes: number;
  duration_s: number;
  source: string;
  warnings: string[];
}

/** Everything that touches the OS goes through here so the command stays hermetically testable. */
export interface RecordDeps {
  record(input: Record<string, unknown>): Promise<Record<string, unknown>>;
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
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    const commonRes = parseCommonOption(common, argv, index);
    if (commonRes) {
      index += commonRes.consumed;
      continue;
    }
    if (value === '--duration') {
      const raw = takeValue(index, '--duration', 'seconds');
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > RECORD_MAX_DURATION_S) {
        throw new ScriptExitError(
          1,
          `--duration must be 1-${RECORD_MAX_DURATION_S} seconds, got "${raw}"`
        );
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

function resolveRecordOut(out: string | undefined): string {
  const candidate =
    out ?? path.join('active/shared/runtime/computer', `screen-recording-${Date.now()}.mp4`);
  const target = pathResolver.rootResolve(candidate);
  if (!isInsideRepository(target)) {
    throw new ScriptExitError(1, `[record] --out ${candidate} must be inside the repository`);
  }
  const ext = path.extname(target).toLowerCase();
  if (!(RECORD_OUT_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new ScriptExitError(
      1,
      `[record] unsupported file type "${ext || '(none)'}". Supported: ${RECORD_OUT_EXTENSIONS.join(', ')}.`
    );
  }
  return target;
}

export function renderRecordResult(result: RecordResult, asJson: boolean): string {
  if (asJson) return JSON.stringify(result, null, 2);
  const lines = [
    `[record] wrote ${result.out} (${result.bytes} bytes, ~${result.duration_s}s, ${result.source})`,
  ];
  lines.push(...result.warnings.map((w) => `> [record] ${w}`));
  return lines.join('\n');
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
  const target = resolveRecordOut(args.out);
  let raw: Record<string, unknown>;
  try {
    raw = await deps.record({
      action: 'system:record_screen',
      params: {
        capture_mode: 'screen',
        duration: args.durationS,
        output: target,
        export_as: 'screen_recording',
      },
    });
  } catch (error) {
    throw new ScriptExitError(
      1,
      `[record] system:record_screen failed: ${(error as Error).message}`
    );
  }
  const nested = raw.screen_recording as Record<string, unknown> | undefined;
  const saved =
    (typeof nested?.output_path === 'string' ? nested.output_path : undefined) ??
    (typeof nested?.path === 'string' ? nested.path : undefined) ??
    (typeof raw.output_path === 'string' ? raw.output_path : undefined) ??
    target;
  const relative = path.relative(pathResolver.rootDir(), saved);
  let bytes = 0;
  try {
    bytes = safeStat(saved).size;
  } catch {
    throw new ScriptExitError(
      1,
      `[record] system:record_screen reported success but ${relative} is unreadable`
    );
  }
  const result: RecordResult = {
    out: relative,
    bytes,
    duration_s: args.durationS,
    source: args.source,
    warnings: [],
  };
  print(renderRecordResult(result, args.json));
  return result;
}
