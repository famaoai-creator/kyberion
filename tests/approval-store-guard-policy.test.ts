import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { approvalStoreRoots } from '@agent/core/governance/approval-store';
import {
  VITEST_APPROVAL_STORE_ROOT,
  leftoverVerdict,
  poolApprovalStoreDir,
} from './approval-store-guard-policy.js';
import { VITEST_APPROVAL_STORE_ROOT as CORE_ROOT } from '@agent/core/governance/approval-store';

describe('approval-store guard policy', () => {
  it('targets exactly the per-pool directory approvalStoreRoots() writes to', () => {
    expect(VITEST_APPROVAL_STORE_ROOT).toBe(CORE_ROOT);
    for (const pool of ['1', '3', 'x/../2']) {
      const env = { VITEST: 'true', VITEST_POOL_ID: pool };
      const dir = poolApprovalStoreDir('/repo', env);
      const roots = approvalStoreRoots(env);
      for (const root of Object.values(roots)) {
        expect(path.join('/repo', root).startsWith(`${dir}${path.sep}`)).toBe(true);
      }
    }
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

  it('caps the evidence list', () => {
    const leftovers = Array.from({ length: 13 }, (_, i) => `f${i}.json`);
    expect(leftoverVerdict({ ...base, leftovers }).message).toContain('(+3 more)');
  });
});
