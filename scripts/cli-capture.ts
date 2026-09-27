/**
 * `pnpm kyberion capture [--screen | --window | --camera] [--out <image>] [--json]`
 *
 * The action-side counterpart of `pnpm kyberion see`: still-image capture
 * through the governed system-actuator (`screenshot` / `capture_photo`) — no
 * capture code of its own. Screen-frame redaction stays inside the actuator;
 * this verb only owns arg parsing, repo-boundary checks, and the summary output.
 *
 * Invocation follows the pipeline-steps form
 * (`{action:'pipeline', steps:[{type:'capture', op, params}]}`) — the only
 * form the system-actuator executes. Stdout carries the summary (or --json);
 * the image lands in --out inside the governed store.
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile, safeStat } from '@agent/core/secure-io';
import { ScriptExitError } from './lib/harness.js';
import { isInsideRepository, parseCommonOption, sniffImageDimensions } from './lib/perception.js';

export const CAPTURE_USAGE = `Usage: pnpm kyberion capture [--screen | --window | --camera] [--out <image>] [--json]

Captures a still image through the governed capture bridges (screen captures are redacted).
  --screen       Capture the current screen (default)
  --window       Capture the focused window (system:screenshot focused_window mode)
  --camera       Capture a still photo from the camera (system:capture_photo)
  --out <file>   Where to write (png / jpg / jpeg / webp) inside the governed store
                 (runtime/computer/screenshots/ or /photos/) or active/shared/tmp/
                 Default: runtime/computer/screenshots/capture-<timestamp>.png
                          (photos/ for --camera)
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

export function buildScreenshotPipelineInput(
  target: string,
  captureMode: 'screen' | 'focused_window'
): Record<string, unknown> {
  return {
    action: 'pipeline',
    steps: [
      {
        type: 'capture',
        op: 'screenshot',
        params: { capture_mode: captureMode, path: target, export_as: 'screenshot_path' },
      },
    ],
  };
}

export function buildPhotoPipelineInput(target: string): Record<string, unknown> {
  return {
    action: 'pipeline',
    steps: [
      {
        type: 'capture',
        op: 'capture_photo',
        params: { path: target, camera_intent: 'reference', export_as: 'photo_path' },
      },
    ],
  };
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

function resolveCaptureOut(out: string | undefined, mode: CaptureArgs['mode']): string {
  const store = mode === 'camera' ? 'photos' : 'screenshots';
  const candidate =
    out ?? path.join('active/shared/runtime/computer', store, `capture-${Date.now()}.png`);
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
  const target = resolveCaptureOut(args.out, args.mode);
  const input =
    args.mode === 'camera'
      ? buildPhotoPipelineInput(target)
      : buildScreenshotPipelineInput(target, args.mode === 'window' ? 'focused_window' : 'screen');
  const opName = args.mode === 'camera' ? 'capture_photo' : 'screenshot';
  let raw: Record<string, unknown>;
  try {
    raw = await deps.capture(input);
  } catch (error) {
    throw new ScriptExitError(1, `[capture] system:${opName} failed: ${(error as Error).message}`);
  }
  const context =
    raw.context && typeof raw.context === 'object' ? (raw.context as Record<string, unknown>) : raw;
  const saved =
    typeof context.screenshot_path === 'string'
      ? context.screenshot_path
      : typeof context.photo_path === 'string'
        ? context.photo_path
        : target;
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
      `[capture] system:${opName} reported success but ${relative} is unreadable`
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
