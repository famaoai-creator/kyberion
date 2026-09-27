/**
 * `pnpm kyberion capture --screen|--window [--out <image>] [--json]`
 *
 * The action-side counterpart of `pnpm kyberion see`: still-image capture
 * through the governed system-actuator (`system:screenshot`) — no capture
 * code of its own. Screen-frame redaction stays inside the actuator; this
 * verb only owns arg parsing, repo-boundary checks, and the summary output.
 *
 * P1 covers screen + focused window. `--camera` is a governed not-yet
 * (P2: system:capture_photo) so callers get guidance instead of a stack trace.
 *
 * Outputs must land in the actuator's governed store
 * (`runtime/computer/screenshots/` or shared `tmp/`); anything else is refused.
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile, safeStat } from '@agent/core/secure-io';
import { ScriptExitError } from './lib/harness.js';
import { isInsideRepository, parseCommonOption, sniffImageDimensions } from './lib/perception.js';

export const CAPTURE_USAGE = `Usage: pnpm kyberion capture [--screen | --window | --camera] [--out <image>] [--json]

Captures a still image through the governed screen-capture bridge (with redaction).
  --screen       Capture the current screen (default)
  --window       Capture the focused window (system:screenshot focused_window mode)
  --camera       Camera still (not yet: P2 system:capture_photo)
  --out <file>   Where to write (png / jpg / jpeg / webp) inside runtime/computer/screenshots/ or active/shared/tmp/
                 Default: runtime/computer/screenshots/capture-<timestamp>.png
  --json         Print {out, bytes, width, height, mode, warnings} as JSON
  --verbose      Keep runtime logs (off by default)

Read it back with \`pnpm kyberion see <image>\`.`;

export const CAPTURE_OUT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;

export interface CaptureArgs {
  json: boolean;
  help: boolean;
  out?: string;
  mode: 'screen' | 'window' | 'camera';
}

export interface CaptureResult {
  out: string;
  bytes: number;
  width?: number;
  height?: number;
  mode: string;
  warnings: string[];
}

/** Everything that touches the OS goes through here so the command stays hermetically testable. */
export interface CaptureDeps {
  capture(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export const defaultCaptureDeps: CaptureDeps = {
  async capture(input) {
    const { handleAction } = await import('../libs/actuators/system-actuator/src/index.js');
    return (await handleAction(input as never)) as Record<string, unknown>;
  },
};

function parseCaptureArgs(argv: string[]): CaptureArgs {
  const args: CaptureArgs = { json: false, help: false, mode: 'screen' };
  const common: { json: boolean; help: boolean; out?: string } = {
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    const commonRes = parseCommonOption(common, argv, index);
    if (commonRes) {
      index += commonRes.consumed;
      continue;
    }
    if (value === '--screen') args.mode = 'screen';
    else if (value === '--window') args.mode = 'window';
    else if (value === '--camera') args.mode = 'camera';
    else if (value.startsWith('--')) throw new ScriptExitError(1, `Unknown option: ${value}`);
    else throw new ScriptExitError(1, `Unexpected argument: ${value}`);
  }
  args.json = common.json;
  args.help = common.help;
  args.out = common.out;
  return args;
}

function resolveCaptureOut(out: string | undefined): string {
  const candidate =
    out ?? path.join('active/shared/runtime/computer/screenshots', `capture-${Date.now()}.png`);
  const target = pathResolver.rootResolve(candidate);
  if (!isInsideRepository(target)) {
    throw new ScriptExitError(1, `[capture] --out ${candidate} must be inside the repository`);
  }
  const ext = path.extname(target).toLowerCase();
  if (!(CAPTURE_OUT_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new ScriptExitError(
      1,
      `[capture] unsupported file type "${ext || '(none)'}". Supported: ${CAPTURE_OUT_EXTENSIONS.join(', ')}.`
    );
  }
  return target;
}

export function renderCaptureResult(result: CaptureResult, asJson: boolean): string {
  if (asJson) return JSON.stringify(result, null, 2);
  const dims = result.width && result.height ? `, ${result.width}x${result.height}` : '';
  const lines = [`[capture] wrote ${result.out} (${result.bytes} bytes${dims}, ${result.mode})`];
  lines.push(...result.warnings.map((w) => `> [capture] ${w}`));
  return lines.join('\n');
}

export async function runCaptureCommand(
  argv: string[],
  print: (text: string) => void,
  deps: CaptureDeps = defaultCaptureDeps
): Promise<CaptureResult | undefined> {
  const args = parseCaptureArgs(argv);
  if (args.help) {
    print(CAPTURE_USAGE);
    return undefined;
  }
  if (args.mode === 'camera') {
    throw new ScriptExitError(
      1,
      '[capture] --camera is not available yet (P2: system:capture_photo). Use --screen or --window for now.'
    );
  }
  const target = resolveCaptureOut(args.out);
  const captureMode = args.mode === 'window' ? 'focused_window' : 'screen';
  let raw: Record<string, unknown>;
  try {
    raw = await deps.capture({
      action: 'system:screenshot',
      params: {
        capture_mode: captureMode,
        path: target,
        export_as: 'screenshot_path',
      },
    });
  } catch (error) {
    throw new ScriptExitError(1, `[capture] system:screenshot failed: ${(error as Error).message}`);
  }
  const saved = typeof raw.screenshot_path === 'string' ? raw.screenshot_path : target;
  const relative = path.relative(pathResolver.rootDir(), saved);
  let bytes = 0;
  let width: number | undefined;
  let height: number | undefined;
  try {
    const stat = safeStat(saved);
    bytes = stat.size;
    const buffer = safeReadFile(saved, { encoding: null }) as Buffer;
    const dims = sniffImageDimensions(buffer);
    width = dims.width;
    height = dims.height;
  } catch {
    // The actuator reported success; a missing file is still an error surface.
    throw new ScriptExitError(
      1,
      `[capture] system:screenshot reported success but ${relative} is unreadable`
    );
  }
  const result: CaptureResult = {
    out: relative,
    bytes,
    width,
    height,
    mode: args.mode,
    warnings: [],
  };
  print(renderCaptureResult(result, args.json));
  return result;
}
