/**
 * Vitest setup file: keep the per-pool test approval store from carrying state
 * from one test file into the next.
 *
 * Under Vitest, approvals, decision cards and autonomous-action notices go to
 * `active/shared/runtime/vitest-approvals/pool-<VITEST_POOL_ID>/`
 * (`approvalStoreRoots()`). Files that run one after another in the same pool
 * slot share that directory, and which files share a slot depends on the
 * scheduler. A file that leaves a record behind therefore breaks a later reader
 * only in some runs: `operations-halt.enforcement.test.ts` left a `Merge PR 7`
 * notice in `autonomy/actions.jsonl`, and `approval-decision-routing.test.ts`
 * read it (2026-10, operations-hygiene-runbook §5).
 *
 * Per test file this guard
 * - clears the pool store before the file starts, so a file never sees what an
 *   earlier (or crashed) file left behind, and
 * - after the file's own hooks have run (`sequence.hooks: 'stack'`), clears what
 *   the file left behind and reports it unless the file is on the baseline
 *   (`tests/fixtures/approval-store-leftover-baseline.json`); under
 *   `KYBERION_TEST_LEAK_STRICT=1` (CI) the report fails the file.
 *
 * It uses `node:fs` directly on purpose: importing the core stack here would put
 * path-resolver and secure-io in every test file's module graph before the
 * file's own `vi.mock` calls.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';
import { leftoverVerdict, poolApprovalStoreDir } from './approval-store-guard-policy.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BASELINE_PATH = path.join(ROOT, 'tests', 'fixtures', 'approval-store-leftover-baseline.json');

function listStoreFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return files.sort();
}

function loadBaseline(): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as { files?: string[] };
    return new Set(parsed.files ?? []);
  } catch {
    return new Set();
  }
}

const storeDir = poolApprovalStoreDir(ROOT, process.env);
let testFile = '<unknown test file>';

beforeAll(() => {
  const file = expect.getState().testPath;
  if (file) testFile = path.relative(ROOT, file).split(path.sep).join('/');
  fs.rmSync(storeDir, { recursive: true, force: true });
});

afterAll(() => {
  const leftovers = listStoreFiles(storeDir);
  if (leftovers.length === 0) return;
  fs.rmSync(storeDir, { recursive: true, force: true });
  const verdict = leftoverVerdict({
    testFile,
    leftovers,
    baseline: loadBaseline(),
    strict: process.env.KYBERION_TEST_LEAK_STRICT === '1',
    storeDir: path.relative(ROOT, storeDir),
  });
  if (verdict.action === 'fail') throw new Error(verdict.message);
  if (verdict.action === 'warn') process.stderr.write(`\n${verdict.message}\n`);
});
