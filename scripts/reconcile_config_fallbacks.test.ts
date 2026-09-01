import { describe, expect, it, vi } from 'vitest';

vi.mock('@agent/core/reconcile-ops', () => ({
  reconcileConfigFallbacks: vi.fn(() => ({
    repaired: [],
    proposals_written: [],
    skipped: [{ knowledge_path: 'confidential/example.json', reason: 'test' }],
    pruned: 0,
  })),
}));

import { runReconcileConfigFallbacks } from './reconcile_config_fallbacks.js';

describe('reconcile config fallbacks CLI', () => {
  it('exposes the governed reconciliation result through the shared script boundary', async () => {
    const result = await runReconcileConfigFallbacks(['--quiet']);
    expect(result).toEqual({
      repaired: [],
      proposals_written: [],
      skipped: [{ knowledge_path: 'confidential/example.json', reason: 'test' }],
      pruned: 0,
    });
  });
});
