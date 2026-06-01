import { describe, expect, it } from 'vitest';

import {
  loadProductionEvidenceSummaryPolicyCatalog,
  resolveProductionEvidenceSummaryPolicy,
} from './production-evidence-summary-policy.js';

describe('production-evidence-summary-policy', () => {
  it('loads the canonical production evidence summary labels', () => {
    const catalog = loadProductionEvidenceSummaryPolicyCatalog();
    expect(catalog.title_prefix).toBe('production evidence');
    expect(catalog.invalid_entries_title).toBe('invalid register entries');
    expect(catalog.pending_title).toBe('pending external evidence');
  });

  it('resolves the policy object', () => {
    expect(resolveProductionEvidenceSummaryPolicy().complete_message).toBe('all production evidence is verified');
  });
});
