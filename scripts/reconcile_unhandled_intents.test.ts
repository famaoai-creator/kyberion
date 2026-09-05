import { describe, expect, it, vi } from 'vitest';

vi.mock('@agent/core/reconcile-ops', () => ({
  reconcileUnhandledIntents: vi.fn(() => ({
    proposals_written: [],
    skipped: [],
    total_unreconciled: 0,
    top_unreconciled: null,
    summary_line: '[UNHANDLED-INTENT] unreconciled=0 top=none',
  })),
}));

import { runReconcileUnhandledIntents } from './reconcile_unhandled_intents.js';

describe('reconcile unhandled intents CLI', () => {
  it('exposes the governed reconciliation result through the shared script boundary', async () => {
    await expect(runReconcileUnhandledIntents(['--quiet'])).resolves.toEqual({
      proposals_written: [],
      skipped: [],
      total_unreconciled: 0,
      top_unreconciled: null,
      summary_line: '[UNHANDLED-INTENT] unreconciled=0 top=none',
    });
  });
});
