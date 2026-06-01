import { describe, expect, it } from 'vitest';

import { loadMissionJournalPolicyCatalog, resolveMissionJournalPolicy } from './mission-journal-policy.js';

describe('mission-journal-policy', () => {
  it('loads the canonical mission journal labels', () => {
    const catalog = loadMissionJournalPolicyCatalog();
    expect(catalog.title).toBe('Mission Journal: Ecosystem Evolution');
    expect(catalog.summary_title).toBe('Summary');
    expect(catalog.trust_scores_title).toBe('Agent Trust Scores');
  });

  it('resolves the policy object', () => {
    expect(resolveMissionJournalPolicy().empty_message).toBe('No missions recorded yet.');
  });
});
