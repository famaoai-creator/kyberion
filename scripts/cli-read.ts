/**
 * `pnpm kyberion read <file> [--ocr] [--json] [--out <file>]`
 *
 * The one-line way for any agent (Claude, Codex, Gemini, …) to read a
 * pdf / pptx / docx / xlsx / html / markdown / text file through the actuator
 * stack instead of writing its own unzip / pdftotext / python script. Delegates to the shared document
 * reader (@agent/core/document-reader) — the same path media:document_digest
 * and the ingest ceremony use — and prints Markdown (or JSON) to stdout.
 *
 * Inputs must live inside the repository (the sandbox boundary is not
 * widened): a file elsewhere is refused with the copy-in instruction. URLs are
 * refused too — remote content is egress-governed (network:fetch).
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  inferDocumentFormat,
  READABLE_DOCUMENT_EXTENSIONS,
  readDocument,
  type ReadDocumentResult,
} from '@agent/core/document-reader';
import { safeWriteFile } from '@agent/core/secure-io';
import { ScriptExitError } from './lib/harness.js';

export const READ_USAGE = `Usage: pnpm kyberion read <file> [--ocr] [--tier <tier>] [--training-use <policy>] [--tenant <slug>] [--json] [--out <file>] [--images <dir>]

Reads a ${Object.keys(READABLE_DOCUMENT_EXTENSIONS).join(' / ')} file with the native engines and prints Markdown.
HTML is converted to Markdown (<title> as the heading; scripts/styles dropped); Markdown / text are printed as-is.
  --ocr         Also OCR embedded images (slides/pages/pictures; pdf/pptx/docx); local_only is the default
  --tier <tier> Classify OCR input as public, confidential, or personal (PII may remain in that tier)
  --tenant <slug> Tenant owning classified input; required for approved external egress
  --training-use <policy> local_only (default), zero_retention, or training_eligible
  --json        Print {format, title, tables, warnings, markdown} as JSON
  --out <file>  Write the Markdown (or JSON) to a file inside the repository instead of stdout
  --verbose     Keep runtime logs (they go to stdout; off by default so stdout is the document)
  --images <dir>  Also write every embedded image (slide/page/picture; EMF/WMF as PNG) into <dir>

The file must be inside the repository. Copy external files first, e.g.
  mkdir -p active/shared/tmp/<job> && cp ~/Downloads/<file> active/shared/tmp/<job>/
URLs are not fetched: remote pages go through the egress-governed network:fetch op
(see knowledge/product/orchestration/document-file-reading-playbook.md).`;

const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

interface ReadArgs {
  file?: string;
  ocr: boolean;
  json: boolean;
  out?: string;
  images?: string;
  tier?: 'public' | 'confidential' | 'personal';
  tenant?: string;
  trainingUse?: 'local_only' | 'zero_retention' | 'training_eligible';
  help: boolean;
}

function parseReadArgs(argv: string[]): ReadArgs {
  const args: ReadArgs = { ocr: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    if (value === '--ocr') args.ocr = true;
    else if (value === '--json') args.json = true;
    else if (value === '--verbose')
      continue; // handled by the CLI dispatcher (keeps runtime logs)
    else if (value === '--help' || value === '-h') args.help = true;
    else if (value === '--out') {
      args.out = argv[index + 1];
      index += 1;
      if (!args.out) throw new ScriptExitError(1, '--out requires a file path');
    } else if (value === '--images') {
      args.images = argv[index + 1];
      index += 1;
      if (!args.images) throw new ScriptExitError(1, '--images requires a directory');
    } else if (value === '--tier') {
      const tier = argv[index + 1];
      index += 1;
      if (tier !== 'public' && tier !== 'confidential' && tier !== 'personal') {
        throw new ScriptExitError(1, '--tier must be public, confidential, or personal');
      }
      args.tier = tier;
    } else if (value === '--tenant') {
      args.tenant = argv[index + 1];
      index += 1;
      if (!args.tenant) throw new ScriptExitError(1, '--tenant requires a slug');
    } else if (value === '--training-use') {
      const policy = argv[index + 1];
      index += 1;
      if (
        policy !== 'local_only' &&
        policy !== 'zero_retention' &&
        policy !== 'training_eligible'
      ) {
        throw new ScriptExitError(
          1,
          '--training-use must be local_only, zero_retention, or training_eligible'
        );
      }
      args.trainingUse = policy;
    } else if (value.startsWith('--')) throw new ScriptExitError(1, `Unknown option: ${value}`);
    else if (!args.file) args.file = value;
    else throw new ScriptExitError(1, `Unexpected argument: ${value}`);
  }
  return args;
}

function isInsideRepository(absolute: string): boolean {
  const relative = path.relative(pathResolver.rootDir(), absolute);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function renderReadResult(result: ReadDocumentResult, asJson: boolean): string {
  if (asJson) return JSON.stringify(result, null, 2);
  if (result.warnings.length === 0) return result.markdown;
  return [result.markdown, '', ...result.warnings.map((warning) => `> [read] ${warning}`)].join(
    '\n'
  );
}

export async function runReadCommand(
  argv: string[],
  print: (text: string) => void
): Promise<ReadDocumentResult | undefined> {
  const args = parseReadArgs(argv);
  if (args.help || !args.file) {
    if (!args.file && !args.help) throw new ScriptExitError(1, READ_USAGE);
    print(READ_USAGE);
    return undefined;
  }
  if (URL_PATTERN.test(args.file)) {
    throw new ScriptExitError(
      1,
      `[read] ${args.file} is a URL — read only reads local files. Fetch remote content through the ` +
        'egress-governed network:fetch op (see knowledge/product/orchestration/document-file-reading-playbook.md), ' +
        'save it under active/shared/tmp/<job>/, then read that file.'
    );
  }
  const absolute = pathResolver.rootResolve(args.file);
  if (!isInsideRepository(absolute)) {
    throw new ScriptExitError(
      1,
      `[read] ${args.file} is outside the repository. Copy it in first:\n` +
        `  mkdir -p active/shared/tmp/<job> && cp "${args.file}" active/shared/tmp/<job>/`
    );
  }
  const format = inferDocumentFormat(absolute);
  if (!format) {
    throw new ScriptExitError(
      1,
      `[read] unsupported file type "${path.extname(absolute) || '(none)'}". ` +
        `Readable: ${Object.keys(READABLE_DOCUMENT_EXTENSIONS).join(', ')}. ` +
        'Other text formats (source code, JSON, CSV, …) can be read directly.'
    );
  }
  if (args.images && !isInsideRepository(pathResolver.rootResolve(args.images))) {
    throw new ScriptExitError(
      1,
      `[read] --images ${args.images} must be a directory inside the repository`
    );
  }
  const result = await readDocument(absolute, format, {
    ocr: args.ocr,
    ...(args.tier ? { tier: args.tier } : {}),
    ...(args.tenant ? { tenantSlug: args.tenant } : {}),
    ...(args.trainingUse ? { trainingUse: args.trainingUse } : {}),
    ...(args.images ? { imagesDir: args.images } : {}),
  });
  const rendered = renderReadResult(result, args.json);
  if (args.images) {
    print(`[read] ${result.images.length} image(s) written to ${args.images}`);
    for (const image of result.images) {
      print(`[read]   ${image.location}: ${path.relative(pathResolver.rootDir(), image.path)}`);
    }
  }
  if (args.out) {
    safeWriteFile(pathResolver.rootResolve(args.out), `${rendered}\n`);
    print(`[read] wrote ${args.out} (${result.format}, ${result.markdown.length} chars)`);
  } else {
    print(rendered);
  }
  return result;
}
