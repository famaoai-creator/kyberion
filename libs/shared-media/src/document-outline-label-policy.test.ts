import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

import {
  resolveReportSectionTitle,
  resolveReportSummaryTitle,
} from './document-outline-label-policy.js';

describe('document-outline-label-policy', () => {
  it('uses the canonical catalog without a duplicated fallback definition', () => {
    const source = safeReadFile(
      pathResolver.rootResolve('libs/shared-media/src/document-outline-label-policy.ts'),
      { encoding: 'utf8' }
    ) as string;
    expect(source).not.toContain('FALLBACK_CATALOG');
  });

  it('exposes report outline labels', () => {
    expect(resolveReportSummaryTitle()).toBe('Summary');
    expect(resolveReportSectionTitle()).toBe('Section');
  });
});
