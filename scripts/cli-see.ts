/**
 * `pnpm kyberion see <image> [--describe] [--lang <bcp47>] [--json] [--out <file>]`
 *
 * The one-line way for any agent to read the text in an image through the
 * governed OCR bridge (@agent/core/ocr-bridge) instead of improvising a
 * tesseract / Vision script. OCR runs with `mode: 'local_only'` — the image
 * never leaves the machine. `--describe` additionally asks the image
 * description bridge for a caption and says which provider served it.
 *
 * Inputs must live inside the repository (same boundary as `kyberion read`).
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { ScriptExitError } from './lib/harness.js';
import {
  assertExtension,
  defaultPerceptionDeps,
  emitOutput,
  IMAGE_EXTENSIONS,
  parseCommonOption,
  resolveRepositoryInput,
  sniffImageDimensions,
  type CommonArgs,
  type PerceptionDeps,
} from './lib/perception.js';

export const SEE_USAGE = `Usage: pnpm kyberion see <image> [--describe] [--lang <bcp47>] [--json] [--out <file>]

Reads the text in a ${IMAGE_EXTENSIONS.join(' / ')} image with local OCR (no data egress) and prints Markdown.
  --describe     Also caption the image via the image description bridge (provider noted in the output)
  --lang <tag>   OCR language hint, e.g. ja, en, ja+en
  --json         Print {file, bytes, width, height, ocr, description, warnings} as JSON
  --out <file>   Write the Markdown (or JSON) to a file inside the repository instead of stdout
  --verbose      Keep runtime logs (they go to stdout; off by default so stdout is the content)

The file must be inside the repository. Copy external files first, e.g.
  mkdir -p active/shared/tmp/<job> && cp ~/Downloads/<image> active/shared/tmp/<job>/`;

interface SeeArgs extends CommonArgs {
  describe: boolean;
}

export interface SeeResult {
  file: string;
  bytes: number;
  width?: number;
  height?: number;
  ocr?: { text: string; provider: string; confidence: number; data_egress?: string };
  description?: { text: string; provider: string };
  warnings: string[];
}

function parseSeeArgs(argv: string[]): SeeArgs {
  const args: SeeArgs = { json: false, help: false, describe: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    const common = parseCommonOption(args, argv, index);
    if (common) {
      index += common.consumed;
      continue;
    }
    if (value === '--describe') args.describe = true;
    else if (value.startsWith('--')) throw new ScriptExitError(1, `Unknown option: ${value}`);
    else if (!args.file) args.file = value;
    else throw new ScriptExitError(1, `Unexpected argument: ${value}`);
  }
  return args;
}

export function renderSeeResult(result: SeeResult, asJson: boolean): string {
  if (asJson) return JSON.stringify(result, null, 2);
  const dims = result.width && result.height ? `, ${result.width}×${result.height}` : '';
  const lines = [
    `# ${path.basename(result.file)}`,
    '',
    `- file: ${result.file} (${result.bytes} bytes${dims})`,
  ];
  if (result.ocr) {
    lines.push(
      `- ocr: ${result.ocr.provider} (confidence ${Math.round(result.ocr.confidence)}, egress ${result.ocr.data_egress ?? 'none'})`
    );
  }
  if (result.description) lines.push('', '## Description', '', result.description.text.trim());
  lines.push('', '## Text', '', result.ocr?.text.trim() || '_(no text recognized)_');
  if (result.warnings.length > 0) lines.push('', ...result.warnings.map((w) => `> [see] ${w}`));
  return lines.join('\n');
}

export async function runSeeCommand(
  argv: string[],
  print: (text: string) => void,
  deps: PerceptionDeps = defaultPerceptionDeps
): Promise<SeeResult | undefined> {
  const args = parseSeeArgs(argv);
  if (args.help || !args.file) {
    if (!args.file && !args.help) throw new ScriptExitError(1, SEE_USAGE);
    print(SEE_USAGE);
    return undefined;
  }
  const absolute = resolveRepositoryInput('see', args.file);
  assertExtension('see', absolute, IMAGE_EXTENSIONS);
  let buffer: Buffer;
  try {
    buffer = safeReadFile(absolute, { encoding: null }) as Buffer;
  } catch (error) {
    throw new ScriptExitError(1, `[see] cannot read ${args.file}: ${(error as Error).message}`);
  }
  const relative = path.relative(pathResolver.rootDir(), absolute);
  const result: SeeResult = {
    file: relative,
    bytes: buffer.length,
    ...sniffImageDimensions(buffer),
    warnings: [],
  };
  try {
    const ocr = await deps.ocr({
      path: relative,
      mode: 'local_only',
      ...(args.lang ? { language: args.lang } : {}),
    });
    result.ocr = {
      text: ocr.text,
      provider: ocr.provider,
      confidence: ocr.confidence,
      ...(ocr.providerDataEgress ? { data_egress: ocr.providerDataEgress } : {}),
    };
  } catch (error) {
    result.warnings.push(`local OCR unavailable: ${(error as Error).message}`);
  }
  if (args.describe) {
    try {
      const description = await deps.describe({ path: relative, kind: 'detailed' });
      if (description.status === 'succeeded') {
        result.description = { text: description.description, provider: description.provider };
        result.warnings.push(`description provided by ${description.provider}`);
      } else {
        result.warnings.push(
          `image description failed (${description.provider}): ${description.error ?? 'unknown'}`
        );
      }
    } catch (error) {
      result.warnings.push(`image description unavailable: ${(error as Error).message}`);
    }
  }
  if (!result.ocr && !result.description) {
    throw new ScriptExitError(
      1,
      `[see] nothing could be read from ${args.file}: ${result.warnings.join('; ')}`
    );
  }
  emitOutput(
    'see',
    renderSeeResult(result, args.json),
    args.out,
    print,
    `${result.ocr?.text.length ?? 0} chars`
  );
  return result;
}
