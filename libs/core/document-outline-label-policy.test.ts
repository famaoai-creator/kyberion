import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

import {
  resolveReportSectionTitle,
  resolveReportSummaryTitle,
} from './document-outline-label-policy.js';

describe('document-outline-label-policy', () => {
  it('uses the canonical catalog without a duplicated fallback definition', () => {
    const source = safeReadFile(
      pathResolver.rootResolve('libs/core/document-outline-label-policy.ts'),
      { encoding: 'utf8' }
    ) as string;
    expect(source).not.toContain('FALLBACK_CATALOG');
  });

  it('exposes report outline labels', () => {
    expect(resolveReportSummaryTitle()).toBe('Summary');
    expect(resolveReportSectionTitle()).toBe('Section');
  });
});
