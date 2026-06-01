import { describe, expect, it } from 'vitest';
import {
  loadDocumentInferencePolicyCatalog,
  resolveDocumentProfileCandidates,
  resolveDocumentTypeFromClues,
} from './document-inference-policy.js';

describe('document-inference-policy', () => {
  it('resolves document type and profile candidates from knowledge', () => {
    const catalog = loadDocumentInferencePolicyCatalog();

    expect(catalog.type_rules.length).toBeGreaterThan(0);
    expect(resolveDocumentTypeFromClues('weekly status report with audit findings')).toBe('report');
    expect(resolveDocumentProfileCandidates('report', 'document')).toContain('summary-report');
  });
});
