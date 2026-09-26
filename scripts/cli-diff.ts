/**
 * `pnpm kyberion diff <a> <b> [--json]`
 *
 * Structural fidelity check between two office documents: both are distilled
 * through the same native extractors the `media:*_extract` ops use
 * (docx → DocxDesignProtocol, pptx → PptxDesignProtocol, xlsx →
 * XlsxDesignProtocol) and the resulting designs are compared field-by-field.
 * This is the verification half of an extract → render round-trip: reproduce
 * a document with `pnpm kyberion` (media-docx-roundtrip template /
 * docx_render op), then diff source against output.
 *
 * Inputs must live inside the repository (same boundary as `kyberion read`).
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { ScriptExitError } from './lib/harness.js';
import { assertExtension, resolveRepositoryInput } from './lib/perception.js';

const DIFFABLE_EXTENSIONS = ['.docx', '.pptx', '.xlsx', '.pdf'] as const;
type DiffableExtension = (typeof DIFFABLE_EXTENSIONS)[number];

/** Volatile fields that legitimately differ across any two distill runs. */
const IGNORED_KEYS = new Set(['generatedAt', 'imagePath']);

export const DIFF_USAGE = `Usage: pnpm kyberion diff <a> <b> [--json]

Structural diff of two ${DIFFABLE_EXTENSIONS.join(' / ')} files via their distilled design protocols.
Reports which design fields differ (body blocks, styles, theme, sections, relationships, passthrough parts).
Volatile fields (generatedAt, extracted image paths) are ignored.
  --json      Print {format, identical, diff_count, diffs:[{path, a, b}]} as JSON
  --verbose   Keep runtime logs (off by default so stdout stays the summary)

Both files must be inside the repository and share the same extension.
Round-trip fidelity check:
  pnpm pipeline --input knowledge/product/pipeline-templates/media-docx-roundtrip.json --context '{...}'
  pnpm kyberion diff <source.docx> <roundtrip.docx>`;

interface DiffArgs {
  files: string[];
  json: boolean;
  help: boolean;
}

function parseDiffArgs(argv: string[]): DiffArgs {
  const args: DiffArgs = { files: [], json: false, help: false };
  for (const value of argv) {
    if (value === undefined) continue;
    if (value === '--json') args.json = true;
    else if (value === '--verbose')
      continue; // handled by the CLI dispatcher
    else if (value === '--help' || value === '-h') args.help = true;
    else if (value.startsWith('--')) throw new ScriptExitError(1, `Unknown option: ${value}`);
    else args.files.push(value);
  }
  return args;
}

type Distiller = (filePath: string) => Promise<Record<string, unknown>>;

async function resolveDistiller(ext: DiffableExtension): Promise<Distiller> {
  switch (ext) {
    case '.docx': {
      const { distillDocxDesign } = await import('@agent/core/docx-utils');
      return async (filePath) =>
        (await distillDocxDesign(filePath)) as unknown as Record<string, unknown>;
    }
    case '.pptx': {
      const { distillPptxDesign } = await import('@agent/core/media-contracts');
      return async (filePath) =>
        (await distillPptxDesign(filePath)) as unknown as Record<string, unknown>;
    }
    case '.xlsx': {
      const { distillXlsxDesign } = await import('@agent/core/media-contracts');
      return async (filePath) =>
        (await distillXlsxDesign(filePath)) as unknown as Record<string, unknown>;
    }
    case '.pdf': {
      const { distillPdfDesign } = await import('@agent/core/media-contracts');
      return async (filePath) =>
        (await distillPdfDesign(filePath)) as unknown as Record<string, unknown>;
    }
  }
}

export interface DesignDiffEntry {
  path: string;
  a: string;
  b: string;
}

export interface DesignDiffResult {
  format: DiffableExtension;
  file_a: string;
  file_b: string;
  identical: boolean;
  diff_count: number;
  truncated: boolean;
  diffs: DesignDiffEntry[];
}

const MAX_DIFF_ENTRIES = 50;
const VALUE_PREVIEW_LIMIT = 160;

/**
 * Scalar fields that can key an array element. Design arrays like
 * `relationships`, `passthroughParts`, `headersFooters`, or style
 * `definitions` carry no ordering semantics, so they are compared by key
 * rather than position. Body blocks lack a stable key and stay positional —
 * order is meaningful there. `relationships` is compared by `type+target`
 * (not `id`): rIds of unreferenced parts are internal to the .rels part and
 * may be renumbered freely on render.
 */
const ARRAY_KEY_FIELDS = ['path', 'rId', 'styleId', 'id', 'name', 'section_id'] as const;

interface ArrayKeyer {
  label: string;
  key: (element: unknown) => string | null;
}

function scalarKey(element: unknown, field: string): string | null {
  if (element && typeof element === 'object' && !Array.isArray(element)) {
    const value = (element as Record<string, unknown>)[field];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return null;
}

function typeTargetKey(element: unknown): string | null {
  const type = scalarKey(element, 'type');
  const target = scalarKey(element, 'target');
  return type !== null && target !== null ? `${type}|${target}` : null;
}

/** A keyer that uniquely identifies every element in both arrays, or null. */
function pickArrayKeyer(a: unknown[], b: unknown[]): ArrayKeyer | null {
  const candidates: ArrayKeyer[] = [
    { label: 'type+target', key: typeTargetKey },
    ...ARRAY_KEY_FIELDS.map((field) => ({
      label: field,
      key: (element: unknown) => scalarKey(element, field),
    })),
  ];
  for (const candidate of candidates) {
    const keysA = a.map(candidate.key);
    const keysB = b.map(candidate.key);
    if (
      keysA.every((key) => key !== null) &&
      keysB.every((key) => key !== null) &&
      new Set(keysA).size === keysA.length &&
      new Set(keysB).size === keysB.length
    ) {
      return candidate;
    }
  }
  return null;
}

function previewValue(value: unknown): string {
  if (value === undefined) return '<missing>';
  if (typeof value === 'string' && value.length > VALUE_PREVIEW_LIMIT) {
    return JSON.stringify(`${value.slice(0, VALUE_PREVIEW_LIMIT)}…(${value.length} chars)`);
  }
  const rendered = JSON.stringify(value);
  if (rendered === undefined) return String(value);
  return rendered.length > VALUE_PREVIEW_LIMIT
    ? `${rendered.slice(0, VALUE_PREVIEW_LIMIT)}…(${rendered.length} chars)`
    : rendered;
}

function collectDiffs(
  a: unknown,
  b: unknown,
  diffPath: string,
  out: DesignDiffEntry[],
  limit: number,
  counter: { count: number }
): void {
  if (a === b) return;
  const aIsObj = a !== null && typeof a === 'object';
  const bIsObj = b !== null && typeof b === 'object';
  if (!aIsObj || !bIsObj) {
    counter.count += 1;
    if (out.length < limit)
      out.push({ path: diffPath || '<root>', a: previewValue(a), b: previewValue(b) });
    return;
  }
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) {
    counter.count += 1;
    if (out.length < limit)
      out.push({ path: diffPath || '<root>', a: previewValue(a), b: previewValue(b) });
    return;
  }
  if (aIsArray && bIsArray) {
    const keyer = pickArrayKeyer(a, b);
    if (keyer) {
      const byKey = (arr: unknown[]) =>
        new Map(arr.map((element) => [keyer.key(element)!, element]));
      const mapA = byKey(a);
      const mapB = byKey(b);
      for (const key of new Set([...mapA.keys(), ...mapB.keys()])) {
        collectDiffs(
          mapA.get(key),
          mapB.get(key),
          `${diffPath}[${keyer.label}=${key}]`,
          out,
          limit,
          counter
        );
      }
      return;
    }
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      collectDiffs(a[index], b[index], `${diffPath}[${index}]`, out, limit, counter);
    }
    return;
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  // Relationship entries (type+target) may carry an `id` that is renumbered
  // freely on render — it only matters through references, which are checked
  // elsewhere, so the bare id is not a fidelity signal.
  const isRelationshipEntry =
    typeof aRecord.type === 'string' && typeof aRecord.target === 'string';
  const keys = new Set([...Object.keys(aRecord), ...Object.keys(bRecord)]);
  for (const key of keys) {
    if (IGNORED_KEYS.has(key)) continue;
    if (isRelationshipEntry && key === 'id') continue;
    collectDiffs(
      aRecord[key],
      bRecord[key],
      diffPath ? `${diffPath}.${key}` : key,
      out,
      limit,
      counter
    );
  }
}

export async function diffDesigns(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  context: { format: DiffableExtension; fileA: string; fileB: string }
): Promise<DesignDiffResult> {
  const diffs: DesignDiffEntry[] = [];
  const counter = { count: 0 };
  collectDiffs(a, b, '', diffs, MAX_DIFF_ENTRIES, counter);
  return {
    format: context.format,
    file_a: context.fileA,
    file_b: context.fileB,
    identical: counter.count === 0,
    diff_count: counter.count,
    truncated: counter.count > diffs.length,
    diffs,
  };
}

export async function runDiffCommand(
  argv: string[],
  print: (text: string) => void
): Promise<DesignDiffResult | undefined> {
  const args = parseDiffArgs(argv);
  if (args.help || args.files.length === 0) {
    if (args.files.length === 0 && !args.help) throw new ScriptExitError(1, DIFF_USAGE);
    print(DIFF_USAGE);
    return undefined;
  }
  if (args.files.length !== 2) {
    throw new ScriptExitError(
      1,
      `[diff] expected exactly 2 files, got ${args.files.length}.\n\n${DIFF_USAGE}`
    );
  }

  const absA = resolveRepositoryInput('diff', args.files[0]);
  const absB = resolveRepositoryInput('diff', args.files[1]);
  assertExtension('diff', absA, DIFFABLE_EXTENSIONS);
  assertExtension('diff', absB, DIFFABLE_EXTENSIONS);
  const ext = path.extname(absA).toLowerCase() as DiffableExtension;
  if (path.extname(absB).toLowerCase() !== ext) {
    throw new ScriptExitError(
      1,
      `[diff] files must share the same format (got ${path.extname(absA)} vs ${path.extname(absB)}).`
    );
  }

  const rootDir = pathResolver.rootDir();
  const relA = path.relative(rootDir, absA);
  const relB = path.relative(rootDir, absB);
  const distill = await resolveDistiller(ext);
  const designA = await distill(absA);
  const designB = await distill(absB);

  const result = await diffDesigns(designA, designB, { format: ext, fileA: relA, fileB: relB });
  if (args.json) {
    print(JSON.stringify(result, null, 2));
    return result;
  }
  if (result.identical) {
    print(`[diff] ${result.file_a} == ${result.file_b} (${result.format}) — designs identical`);
  } else {
    print(
      `[diff] ${result.file_a} != ${result.file_b} (${result.format}) — ${result.diff_count} difference(s)`
    );
    for (const entry of result.diffs) {
      print(`- ${entry.path}: ${entry.a} -> ${entry.b}`);
    }
    if (result.truncated)
      print(`… (${result.diff_count - result.diffs.length} more; use --json for the full list)`);
  }
  return result;
}
