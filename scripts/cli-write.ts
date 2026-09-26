/**
 * `pnpm kyberion write <brief.json> --out <file> [--to <target>] [--profile <id>]`
 *
 * The inverse of `pnpm kyberion read`: one line to turn a semantic brief into a
 * pptx / docx / xlsx / pdf through the same seam the `media:generate_document`
 * op uses (buildUnifiedDocumentBrief -> compileBriefToDesignProtocol ->
 * renderCompiledProtocol). Styles come from the design layer's cascade, so a
 * brief never carries per-element style literals.
 *
 * Inputs and outputs must live inside the repository (the sandbox boundary is
 * not widened). Per-format ops (pptx_render / docx_render / xlsx_render /
 * pdf_render) are compatibility adapters — prefer this verb or the op.
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeStat } from '@agent/core/secure-io';
import { ScriptExitError } from './lib/harness.js';
import { readSafeJsonFile } from './lib/json-input.js';

/** Render targets `media:generate_document` dispatches on, mapped to their extension. */
export const WRITABLE_RENDER_TARGETS = {
  pptx: '.pptx',
  docx: '.docx',
  xlsx: '.xlsx',
  pdf: '.pdf',
} as const;

export type RenderTarget = keyof typeof WRITABLE_RENDER_TARGETS;

export const WRITE_USAGE = `Usage: pnpm kyberion write <brief.json> --out <file> [--to ${Object.keys(WRITABLE_RENDER_TARGETS).join('|')}] [--profile <id>] [--json]

Turns a semantic brief into a ${Object.keys(WRITABLE_RENDER_TARGETS).join(' / ')} through the design layer
(the same path as the media:generate_document op). The brief carries content and intent;
the theme, layout and styles come from the design-defaults cascade.
  --out <file>   Where to write the document (inside the repository; required)
  --to <target>  Render target; defaults to the brief's render_target, else the --out extension
  --profile <id> Document composition profile (defaults to the brief's document_profile, else inferred)
  --json         Print {render_target, profile_id, output_path, bytes} as JSON instead of the summary
  --verbose      Keep runtime logs (off by default so stdout stays the summary)

The brief and the output must be inside the repository, e.g.
  mkdir -p active/shared/tmp/<job> && pnpm kyberion write active/shared/tmp/<job>/brief.json --out active/shared/tmp/<job>/deck.pptx
Reading a document back is \`pnpm kyberion read\`; see
knowledge/product/orchestration/capability-verb-inventory.md.`;

interface WriteArgs {
  brief?: string;
  out?: string;
  to?: string;
  profile?: string;
  json: boolean;
  help: boolean;
}

function parseWriteArgs(argv: string[]): WriteArgs {
  const args: WriteArgs = { json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    const takeValue = (label: string): string => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        throw new ScriptExitError(1, `${value} requires ${label}`);
      }
      index += 1;
      return next;
    };
    if (value === '--json') args.json = true;
    else if (value === '--verbose')
      continue; // handled by the CLI dispatcher
    else if (value === '--help' || value === '-h') args.help = true;
    else if (value === '--out') args.out = takeValue('a file path');
    else if (value === '--to') args.to = takeValue('a render target');
    else if (value === '--profile') args.profile = takeValue('a profile id');
    else if (value.startsWith('--')) throw new ScriptExitError(1, `Unknown option: ${value}`);
    else if (!args.brief) args.brief = value;
    else throw new ScriptExitError(1, `Unexpected argument: ${value}`);
  }
  return args;
}

function isInsideRepository(absolute: string): boolean {
  const relative = path.relative(pathResolver.rootDir(), absolute);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveInsideRepository(label: string, file: string): string {
  const absolute = pathResolver.rootResolve(file);
  if (!isInsideRepository(absolute)) {
    throw new ScriptExitError(
      1,
      `[write] ${label} ${file} is outside the repository. Keep it under the repository, e.g.\n` +
        '  mkdir -p active/shared/tmp/<job>'
    );
  }
  return absolute;
}

/**
 * `--to` wins, then the brief's own `render_target`, then the `--out`
 * extension — so `--out deck.pptx` needs no second flag.
 */
export function resolveRenderTarget(
  explicit: string | undefined,
  briefTarget: unknown,
  outPath: string
): RenderTarget {
  const candidate = String(explicit || briefTarget || '')
    .trim()
    .toLowerCase();
  const fromExtension = path.extname(outPath).toLowerCase();
  const resolved =
    candidate ||
    Object.entries(WRITABLE_RENDER_TARGETS).find(([, ext]) => ext === fromExtension)?.[0] ||
    '';
  if (!(resolved in WRITABLE_RENDER_TARGETS)) {
    throw new ScriptExitError(
      1,
      `[write] unsupported render target "${resolved || '(none)'}". ` +
        `Supported: ${Object.keys(WRITABLE_RENDER_TARGETS).join(', ')}. ` +
        'Pass --to, or give --out one of those extensions.'
    );
  }
  const target = resolved as RenderTarget;
  const expected = WRITABLE_RENDER_TARGETS[target];
  if (fromExtension && fromExtension !== expected) {
    throw new ScriptExitError(
      1,
      `[write] --to ${target} writes ${expected} but --out ends in "${fromExtension}". ` +
        'Make the extension match the render target.'
    );
  }
  return target;
}

export interface WriteDocumentResult {
  render_target: RenderTarget;
  profile_id: string;
  output_path: string;
  bytes: number;
}

export async function runWriteCommand(
  argv: string[],
  print: (text: string) => void
): Promise<WriteDocumentResult | undefined> {
  const args = parseWriteArgs(argv);
  if (args.help || !args.brief) {
    if (!args.brief && !args.help) throw new ScriptExitError(1, WRITE_USAGE);
    print(WRITE_USAGE);
    return undefined;
  }
  if (!args.out) throw new ScriptExitError(1, `[write] --out is required.\n\n${WRITE_USAGE}`);

  const briefPath = resolveInsideRepository('brief', args.brief);
  if (path.extname(briefPath).toLowerCase() !== '.json') {
    throw new ScriptExitError(
      1,
      `[write] the brief must be a .json file (got "${path.extname(briefPath) || '(none)'}"). ` +
        'Prose outlines go through the media:document_outline_from_brief op first.'
    );
  }
  const outPath = assertSafeRepositoryPath(resolveInsideRepository('--out', args.out), {
    allowMissingLeaf: true,
  });
  const brief = readSafeJsonFile<Record<string, unknown>>(briefPath, 'document brief');
  const renderTarget = resolveRenderTarget(args.to, brief.render_target, outPath);

  // Imported lazily so `--help` and argument errors cost no catalog loading.
  const { buildUnifiedDocumentBrief } =
    await import('../libs/actuators/media-actuator/src/media-document-helpers.js');
  const { compileBriefToDesignProtocol, renderCompiledProtocol, loadDocumentCompositionCatalog } =
    await import('../libs/actuators/media-actuator/src/media-design-protocol.js');

  const rootDir = pathResolver.rootDir();
  const unified = buildUnifiedDocumentBrief(
    rootDir,
    { renderTarget, source: brief, ...(args.profile ? { profileId: args.profile } : {}) },
    loadDocumentCompositionCatalog
  );
  const compiled = compileBriefToDesignProtocol(rootDir, unified);
  await renderCompiledProtocol(compiled, outPath);

  const result: WriteDocumentResult = {
    render_target: renderTarget,
    profile_id: String(unified?.document_profile || args.profile || ''),
    output_path: path.relative(rootDir, outPath),
    bytes: safeStat(outPath).size,
  };
  print(
    args.json
      ? JSON.stringify(result, null, 2)
      : `[write] wrote ${result.output_path} (${result.render_target}` +
          `${result.profile_id ? `, profile ${result.profile_id}` : ''}, ${result.bytes} bytes)`
  );
  return result;
}
