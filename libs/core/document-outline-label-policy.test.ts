import { describe, expect, it } from 'vitest';

import { resolveReportSectionTitle, resolveReportSummaryTitle } from './document-outline-label-policy.js';

describe('document-outline-label-policy', () => {
  it('exposes report outline labels', () => {
    expect(resolveReportSummaryTitle()).toBe('Summary');
    expect(resolveReportSectionTitle()).toBe('Section');
  });
});
