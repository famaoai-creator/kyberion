import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import {
  loadDocumentInferencePolicyCatalog,
  resolveDocumentProfileCandidates,
  resolveDocumentTypeFromClues,
} from './document-inference-policy.js';

describe('document-inference-policy', () => {
  it('uses the canonical catalog without a duplicated fallback definition', () => {
    const source = safeReadFile(
      pathResolver.rootResolve('libs/shared-media/src/document-inference-policy.ts'),
      { encoding: 'utf8' }
    ) as string;
    expect(source).not.toContain('FALLBACK_CATALOG');
  });

  it('resolves document type and profile candidates from knowledge', () => {
    const catalog = loadDocumentInferencePolicyCatalog();

    expect(catalog.type_rules.length).toBeGreaterThan(0);
    expect(resolveDocumentTypeFromClues('weekly status report with audit findings')).toBe('report');
    expect(resolveDocumentProfileCandidates('report', 'document')).toContain('summary-report');
  });
});
