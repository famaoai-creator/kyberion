/**
 * G14: recurrence gate for undeclared runtime stores.
 *
 * Every store a module writes directly under `active/shared/runtime/<name>`
 * (a directory or a top-level ledger/state file) must have an entry in the
 * storage retention catalog. Without one the janitor neither expires it nor
 * — before G01 — even reported it, which is how append-only ledgers grew
 * without bound unnoticed. The janitor's uncovered report only sees stores
 * that already exist on some machine; this gate catches the literal path in
 * source, before the store ever ships.
 *
 * Detection is deliberately literal (low false-positive rate over full recall):
 *   - `active/shared/runtime/<name>` anywhere in a line;
 *   - `shared('runtime/<name>` / `pathResolver.shared("runtime/<name>` (any quote).
 * A name immediately followed by `${` or `{{` is dynamic and skipped. Test
 * files and `__tests__/` helpers are not scanned. Intentional non-stores
 * (fixture strings, read-only probes) go in RUNTIME_STORE_EXEMPTIONS with a
 * reason.
 */
import path from 'node:path';
import { readTextFile } from '@agent/core/foundation';
import { getAllFiles } from '@agent/core/fs-utils';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat } from '@agent/core/secure-io';
import {
  coveredRuntimeSubdirs,
  loadRetentionCatalog,
  RETENTION_CATALOG_REPO_PATH,
  type LoadedRetentionCatalog,
} from '@agent/core';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export const RUNTIME_STORE_SOURCE_ROOTS = ['libs', 'scripts', 'satellites', 'presence'] as const;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const SKIP_DIRECTORY_SEGMENTS = new Set(['node_modules', 'dist', '.next', 'coverage', '__tests__']);

export interface RuntimeStoreExemption {
  /** Top-level runtime name (first path segment under `active/shared/runtime/`). */
  name: string;
  /** Repo-relative files the exemption applies to; omit only for a repo-wide non-store. */
  files?: string[];
  reason: string;
}

/** Literal runtime names that are not stores. Every entry needs a reason. */
export const RUNTIME_STORE_EXEMPTIONS: readonly RuntimeStoreExemption[] = [
  {
    name: 'evidence',
    files: ['scripts/check_contract_schemas_checks_1.ts'],
    reason: 'schema-validation fixture string (evidence_refs); nothing writes the path',
  },
  {
    name: 'auto-checkpoint.jsonl',
    files: ['scripts/soak_endurance.ts'],
    reason: 'soak probe only samples the size of this path when present; no writer exists',
  },
  {
    name: 'mission-journal.jsonl',
    files: ['scripts/soak_endurance.ts'],
    reason: 'soak probe only samples the size of this path when present; no writer exists',
  },
];

export interface RuntimeStoreReference {
  name: string;
  file: string;
  line: number;
}

// Name: a literal path segment. Trailing dots are sentence punctuation in
// comments ("…/migrations.applied.json."), not part of the name.
const NAME = '([A-Za-z0-9_][A-Za-z0-9_.-]*)';
const REFERENCE_PATTERNS = [
  new RegExp(`active/shared/runtime/${NAME}`, 'gu'),
  new RegExp(`\\bshared\\(\\s*['"\`]runtime/${NAME}`, 'gu'),
];

/** Extract literal runtime store names from one source file. */
export function findRuntimeStoreReferences(source: string, file: string): RuntimeStoreReference[] {
  const refs: RuntimeStoreReference[] = [];
  // Whole-source matching so a wrapped call — `shared(\n  'runtime/<name>'` —
  // is still seen; the reported line is the line holding the name itself.
  for (const pattern of REFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const raw = match[1]!;
      const end = (match.index ?? 0) + match[0].length;
      // `runtime/foo-${id}` / `runtime/{{x}}`: the literal is only a prefix.
      if (source[end] === '{' || source.startsWith('${', end)) continue;
      const name = raw.replace(/\.+$/u, '');
      if (!name) continue;
      const line = source.slice(0, end - raw.length).split('\n').length;
      refs.push({ name, file, line });
    }
  }
  return refs.sort((a, b) => a.line - b.line);
}

function isExempt(
  ref: RuntimeStoreReference,
  exemptions: readonly RuntimeStoreExemption[]
): boolean {
  return exemptions.some(
    (exemption) =>
      exemption.name === ref.name && (!exemption.files || exemption.files.includes(ref.file))
  );
}

/**
 * Pure core: references whose name the catalog does not cover, as
 * `file:line` violations with the fix spelled out.
 */
export function checkRuntimeStoreReferences(
  refs: readonly RuntimeStoreReference[],
  catalog: LoadedRetentionCatalog,
  exemptions: readonly RuntimeStoreExemption[] = RUNTIME_STORE_EXEMPTIONS
): string[] {
  if (catalog.source !== 'catalog') {
    return [
      `${RETENTION_CATALOG_REPO_PATH}: did not load (${catalog.warnings.join('; ') || 'fallback'}) — fix the catalog first`,
    ];
  }
  const covered = coveredRuntimeSubdirs(catalog);
  const violations: string[] = [];
  for (const ref of refs) {
    if (covered.has(ref.name) || isExempt(ref, exemptions)) continue;
    violations.push(
      `${ref.file}:${ref.line}: runtime store 'active/shared/runtime/${ref.name}' has no retention entry — add an entry to ${RETENTION_CATALOG_REPO_PATH} (path, artifact_class, action: TTL+delete, or review_required for load-bearing state)`
    );
  }
  return violations;
}

/** Exemptions that no longer match any reference are dead weight; report them. */
export function findStaleExemptions(
  refs: readonly RuntimeStoreReference[],
  exemptions: readonly RuntimeStoreExemption[] = RUNTIME_STORE_EXEMPTIONS
): string[] {
  return exemptions
    .filter((exemption) => !refs.some((ref) => isExempt(ref, [exemption])))
    .map(
      (exemption) =>
        `scripts/check_runtime_store_retention.ts: exemption '${exemption.name}' matches no reference — remove it`
    );
}

export function readRuntimeStoreSourceFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

function isScannedSource(relativePath: string): boolean {
  if (!SOURCE_EXTENSIONS.has(path.extname(relativePath))) return false;
  if (/\.d\.[cm]?ts$/u.test(relativePath)) return false;
  if (/(?:\.test|\.spec)\.[cm]?tsx?$/u.test(relativePath)) return false;
  return !relativePath.split('/').some((segment) => SKIP_DIRECTORY_SEGMENTS.has(segment));
}

export function collectRuntimeStoreReferences(
  roots: readonly string[] = RUNTIME_STORE_SOURCE_ROOTS
): RuntimeStoreReference[] {
  const rootDir = pathResolver.rootDir();
  const refs: RuntimeStoreReference[] = [];
  for (const root of roots) {
    const absoluteRoot = pathResolver.rootResolve(root);
    if (!safeExistsSync(absoluteRoot)) continue;
    for (const absolute of getAllFiles(absoluteRoot)) {
      const relative = path.relative(rootDir, absolute).split(path.sep).join('/');
      if (!isScannedSource(relative)) continue;
      refs.push(...findRuntimeStoreReferences(readRuntimeStoreSourceFile(absolute), relative));
    }
  }
  return refs.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : a.file > b.file ? 1 : 0
  );
}

export const runCheckRuntimeStoreRetention = defineScript({
  name: 'check:runtime-store-retention',
  flags: [],
  run(context) {
    const refs = collectRuntimeStoreReferences();
    const failures = [
      ...checkRuntimeStoreReferences(refs, loadRetentionCatalog()),
      ...findStaleExemptions(refs),
    ];
    if (failures.length) {
      throw new ScriptExitError(
        1,
        [
          'runtime store retention check failed — every active/shared/runtime/<name> store needs a retention-catalog entry',
          ...failures.map((failure) => `- ${failure}`),
        ].join('\n')
      );
    }
    const names = new Set(refs.map((ref) => ref.name));
    context.print(
      `[check:runtime-store-retention] OK (${names.size} runtime store names, ${refs.length} references)`
    );
    return { names: names.size, references: refs.length, failures };
  },
});

if (
  isDirectScript(import.meta.url, 'check_runtime_store_retention.ts') ||
  isDirectScript(import.meta.url, 'check_runtime_store_retention.js')
)
  void runCheckRuntimeStoreRetention();
