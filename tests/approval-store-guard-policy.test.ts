import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver, safeExistsSync, safeMkdir, safeReadFile, safeRmSync } from '@agent/core';
import { approvalStoreRoots } from '@agent/core/governance/approval-store';
import {
  VITEST_APPROVAL_STORE_ROOT,
  VITEST_RUN_ID_ENV,
  leftoverVerdict,
  ownRunApprovalStoreDirs,
  poolApprovalStoreDir,
  runApprovalStoreDir,
} from './approval-store-guard-policy.js';
import { removeOwnRunDirs } from './vitest-run-id.js';
import { VITEST_APPROVAL_STORE_ROOT as CORE_ROOT } from '@agent/core/governance/approval-store';

describe('approval-store guard policy', () => {
  it('targets exactly the per-pool directory approvalStoreRoots() writes to', () => {
    expect(VITEST_APPROVAL_STORE_ROOT).toBe(CORE_ROOT);
    for (const pool of ['1', '3', 'x/../2']) {
      for (const run of [undefined, '4242-abc', 'r/../7']) {
        const env = { VITEST: 'true', VITEST_POOL_ID: pool, [VITEST_RUN_ID_ENV]: run };
        const dir = poolApprovalStoreDir('/repo', env);
        expect(dir).not.toBeNull();
        const roots = approvalStoreRoots(env);
        for (const root of Object.values(roots)) {
          expect(path.join('/repo', root).startsWith(`${dir}${path.sep}`)).toBe(true);
        }
      }
    }
  });

  it('gives concurrent runs disjoint pool directories', () => {
    const first = poolApprovalStoreDir('/repo', {
      VITEST_POOL_ID: '1',
      [VITEST_RUN_ID_ENV]: '11-a',
    });
    const second = poolApprovalStoreDir('/repo', {
      VITEST_POOL_ID: '1',
      [VITEST_RUN_ID_ENV]: '12-b',
    });
    expect(first).not.toBe(second);
    expect(first!.startsWith(`${second}${path.sep}`)).toBe(false);
    expect(second!.startsWith(`${first}${path.sep}`)).toBe(false);
  });

  it('targets nothing without a pool id, never the shared base directory', () => {
    expect(poolApprovalStoreDir('/repo', {})).toBeNull();
    expect(poolApprovalStoreDir('/repo', { [VITEST_RUN_ID_ENV]: '11-a' })).toBeNull();
    expect(poolApprovalStoreDir('/repo', { VITEST_POOL_ID: '../' })).toBeNull();
  });

  it('runs this worker under the run nonce vitest.config.mts sets', () => {
    expect(process.env[VITEST_RUN_ID_ENV]).toMatch(/^[\w-]+$/);
    expect(approvalStoreRoots().coordination).toContain(`/run-${process.env[VITEST_RUN_ID_ENV]}/`);
  });

  const base = {
    testFile: 'libs/core/x.test.ts',
    leftovers: ['observability/channels/autonomy/actions.jsonl'],
    baseline: new Set<string>(),
    strict: false,
    storeDir: 'active/shared/runtime/vitest-approvals/pool-1',
  };

  it('does nothing when the file left nothing', () => {
    expect(leftoverVerdict({ ...base, leftovers: [], strict: true })).toEqual({ action: 'none' });
  });

  it('warns locally and fails under strict mode for a file not on the baseline', () => {
    const warn = leftoverVerdict(base);
    expect(warn.action).toBe('warn');
    expect(warn.message).toMatch(
      /^\[vitest-approval-store-guard\] libs\/core\/x\.test\.ts left 1 file\(s\) .+ — .+ \| next: .+ \| evidence: .+autonomy\/actions\.jsonl$/
    );
    expect(leftoverVerdict({ ...base, strict: true }).action).toBe('fail');
  });

  it('stays quiet for baselined debt', () => {
    expect(
      leftoverVerdict({ ...base, strict: true, baseline: new Set(['libs/core/x.test.ts']) })
    ).toEqual({ action: 'none' });
  });

  it('notes a baselined file that left nothing, so the baseline shrinks', () => {
    const note = leftoverVerdict({
      ...base,
      leftovers: [],
      strict: true,
      baseline: new Set(['libs/core/x.test.ts']),
    });
    expect(note.action).toBe('note');
    expect(note.message).toMatch(
      /^\[vitest-approval-store-guard\] libs\/core\/x\.test\.ts left nothing .+ — .+ \| next: remove it from .+ \| evidence: .+$/
    );
  });

  it('caps the evidence list', () => {
    const leftovers = Array.from({ length: 13 }, (_, i) => `f${i}.json`);
    expect(leftoverVerdict({ ...base, leftovers }).message).toContain('(+3 more)');
  });
});

describe('approval-store leftover baseline', () => {
  // Shrink-only: lower this when you remove entries; never raise it.
  const MAX_BASELINED_FILES = 34;
  const baseline = JSON.parse(
    safeReadFile(pathResolver.rootResolve('tests/fixtures/approval-store-leftover-baseline.json'), {
      encoding: 'utf8',
    }) as string
  ) as { files: string[] };

  it('only grows smaller', () => {
    expect(baseline.files.length).toBeLessThanOrEqual(MAX_BASELINED_FILES);
    expect(new Set(baseline.files).size).toBe(baseline.files.length);
    expect([...baseline.files].sort()).toEqual(baseline.files);
  });

  it('lists only test files that exist', () => {
    const missing = baseline.files.filter(
      (file) => !safeExistsSync(pathResolver.rootResolve(file))
    );
    expect(missing).toEqual([]);
  });
});

describe('vitest-run-id globalSetup', () => {
  const root = pathResolver.rootResolve(`active/shared/tmp/vitest-run-id-test-${process.pid}`);
  afterEach(() => {
    safeRmSync(root, { recursive: true, force: true });
  });

  it('removes only the run directories this main process created', () => {
    const dir = (run: string) => runApprovalStoreDir(root, { [VITEST_RUN_ID_ENV]: run })!;
    for (const run of ['4242-a1', '4242-b2', '42421-c3', '1000-outer']) {
      safeMkdir(path.join(dir(run), 'pool-1'), { recursive: true });
    }
    removeOwnRunDirs(root, 4242);
    expect(safeExistsSync(dir('4242-a1'))).toBe(false);
    expect(safeExistsSync(dir('4242-b2'))).toBe(false);
    expect(safeExistsSync(path.join(dir('42421-c3'), 'pool-1'))).toBe(true);
    expect(safeExistsSync(path.join(dir('1000-outer'), 'pool-1'))).toBe(true);
  });

  it('matches the nonce format vitest.config.mts sets', () => {
    const config = safeReadFile(pathResolver.rootResolve('vitest.config.mts'), {
      encoding: 'utf8',
    }) as string;
    expect(config).toContain(
      'process.env.KYBERION_VITEST_RUN_ID ||= `${process.pid}-${Date.now().toString(36)}`;'
    );
    expect(
      ownRunApprovalStoreDirs('/repo', 77, () => [`run-77-${Date.now().toString(36)}`])
    ).toHaveLength(1);
  });

  it('does nothing when the store does not exist', () => {
    expect(() => removeOwnRunDirs(root, 4242)).not.toThrow();
  });
});
