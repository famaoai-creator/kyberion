import { beforeEach, describe, expect, it, vi } from 'vitest';

const reconcile = vi.hoisted(() => ({
  reconcileConfigFallbacks: vi.fn((_options?: { apply?: boolean }) => ({
    applied: false,
    repaired: [],
    planned: [],
    proposals_written: [],
    skipped: [{ knowledge_path: 'confidential/example.json', reason: 'test' }],
    pruned: 0,
  })),
}));

vi.mock('@agent/core/reconcile-ops', () => reconcile);

import { runReconcileConfigFallbacks } from './reconcile_config_fallbacks.js';

describe('reconcile config fallbacks CLI', () => {
  beforeEach(() => reconcile.reconcileConfigFallbacks.mockClear());

  it('exposes the governed reconciliation result through the shared script boundary', async () => {
    const result = await runReconcileConfigFallbacks(['--quiet']);
    expect(result).toEqual({
      applied: false,
      repaired: [],
      planned: [],
      proposals_written: [],
      skipped: [{ knowledge_path: 'confidential/example.json', reason: 'test' }],
      pruned: 0,
    });
  });

  it('is proposal-only unless --apply is passed (B1)', async () => {
    await runReconcileConfigFallbacks(['--quiet']);
    expect(reconcile.reconcileConfigFallbacks).toHaveBeenLastCalledWith({ apply: false });
    await runReconcileConfigFallbacks(['--apply', '--quiet']);
    expect(reconcile.reconcileConfigFallbacks).toHaveBeenLastCalledWith({ apply: true });
  });
});
