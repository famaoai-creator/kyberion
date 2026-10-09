import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import { approvalStoreRoots } from '@agent/core/governance/approval-store';

// Seeded while the file is imported. tests/vitest-approval-store-guard.ts must
// clear the pool store before this import (at its top level), not in a
// beforeAll that runs after it and would erase this record.
const SEED_DIR = pathResolver.rootResolve(
  `${approvalStoreRoots().observability}/guard-import-seed`
);
const SEED = path.join(SEED_DIR, 'seed.json');
safeMkdir(SEED_DIR, { recursive: true });
safeWriteFile(SEED, JSON.stringify({ seeded: 'import' }));

describe('approval-store guard ordering', () => {
  afterAll(() => {
    // This file's own cleanup runs before the guard's leftover check.
    safeRmSync(SEED_DIR, { recursive: true, force: true });
  });

  it('keeps a record the test file seeded at import time', () => {
    expect(safeExistsSync(SEED)).toBe(true);
  });

  it('pins setup-file hooks to run after the file hooks', () => {
    const config = safeReadFile(pathResolver.rootResolve('vitest.config.mts'), {
      encoding: 'utf8',
    }) as string;
    expect(config).toMatch(/sequence:\s*\{\s*hooks:\s*'stack'\s*\}/);
  });
});
