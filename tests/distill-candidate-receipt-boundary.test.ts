import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

/**
 * D8 / MEMORY_LOOP_CLOSURE M2 — DistillCandidateRecord is a promotion receipt.
 *
 * Candidates live on the one MemoryCandidate queue. A DistillCandidateRecord
 * may be written only by the promotion workflow as the receipt of a promotion
 * (`RECEIPT_WRITERS`). `PENDING_MIGRATION` lists the producers that still
 * write a non-receipt (proposed) record and have not been moved to the queue
 * yet; it may only shrink — remove a file when its producer moves, never add
 * one. Every proposal producer moved in M2 (`MOVED_PRODUCERS`) and must never
 * write one again.
 *
 * Test files are exempt (legacy fixtures write read-only history on purpose).
 */
const rootDir = process.cwd();
const SCAN_ROOTS = ['libs', 'scripts', 'presence', 'satellites'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '__tests__', 'coverage']);
const WRITER_CALL = /\b(?:save|update|mutate)DistillCandidateRecord\s*\(/u;

/** The registry defines the writer functions. */
const REGISTRY = 'libs/core/knowledge/distill-candidate-registry.ts';
/** Writes the receipt of a promotion (proposed → promoted / archived in one call). */
const RECEIPT_WRITERS = ['libs/core/knowledge/memory-promotion-workflow.ts'];
/**
 * Non-receipt producers not yet on the queue. Shrink only — empty since the
 * last four (learning intake, service procedures, the browser extension and
 * Concierge mission-seed promotion) moved in M2.
 */
const PENDING_MIGRATION: string[] = [];
/** Flows moved onto the queue in M2: never a DistillCandidateRecord writer again. */
const MOVED_PRODUCERS = [
  /^libs\/core\/workforce\/background-review-/u,
  /^libs\/core\/knowledge\/execution-feedback/u,
  /^libs\/core\/dot\//u,
  /^scripts\/background_review\.ts$/u,
  /^scripts\/operator-home-/u,
  /^libs\/core\/knowledge\/reusable-learning/u,
  /^libs\/core\/knowledge\/reuse-proposals\.ts$/u,
  /^libs\/core\/service\//u,
  /^scripts\/browser_bridge_host\.ts$/u,
  /^presence\/displays\/concierge\//u,
];

function walk(relative: string, out: string[]): void {
  const absolute = path.join(rootDir, relative);
  if (!safeExistsSync(absolute)) return;
  for (const file of getAllFiles(absolute)) {
    const child = path.relative(rootDir, file).split(path.sep).join('/');
    const segments = child.split('/');
    if (segments.slice(0, -1).some((segment) => SKIP_DIRS.has(segment))) continue;
    const name = segments[segments.length - 1];
    if (!/\.(?:ts|tsx|mts)$/u.test(name) || /\.test\.(?:ts|tsx|mts)$/u.test(name)) continue;
    if (/\.d\.ts$/u.test(name)) continue;
    out.push(child);
  }
}

function distillRecordWriters(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(root, files);
  return files
    .filter((file) => file !== REGISTRY)
    .filter((file) =>
      WRITER_CALL.test(safeReadFile(path.join(rootDir, file), { encoding: 'utf8' }) as string)
    )
    .sort();
}

describe('DistillCandidateRecord receipt-only boundary (D8)', () => {
  const writers = distillRecordWriters();

  it('is written only by the promotion receipt and the declared not-yet-migrated producers', () => {
    const allowed = [...RECEIPT_WRITERS, ...PENDING_MIGRATION].sort();
    const added = writers.filter((file) => !allowed.includes(file));
    const removed = allowed.filter((file) => !writers.includes(file));
    expect(
      { added, removed },
      [
        'DistillCandidateRecord writers changed.',
        'added: capture the candidate on the MemoryCandidate queue instead (facade-proposal-rows.ts).',
        'removed: delete the file from PENDING_MIGRATION so the list only shrinks.',
      ].join('\n')
    ).toEqual({ added: [], removed: [] });
  });

  it('keeps every moved producer on the queue', () => {
    expect(writers.filter((file) => MOVED_PRODUCERS.some((pattern) => pattern.test(file)))).toEqual(
      []
    );
  });
});
