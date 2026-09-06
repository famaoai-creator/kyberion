import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

import {
  loadPromotedReportTemplatePolicyCatalog,
  resolvePromotedReportAudience,
  resolvePromotedReportOutputFormat,
  resolvePromotedReportTemplateSections,
} from './promoted-report-template-policy.js';

describe('promoted-report-template-policy', () => {
  it('uses the canonical catalog without a duplicated fallback definition', () => {
    const source = safeReadFile(
      pathResolver.rootResolve('libs/core/promoted-report-template-policy.ts'),
      { encoding: 'utf8' }
    ) as string;
    expect(source).not.toContain('FALLBACK_CATALOG');
  });

  it('loads the default report template policy', () => {
    const catalog = loadPromotedReportTemplatePolicyCatalog();
    expect(catalog.template_sections).toEqual([
      'Summary',
      'Current State',
      'Findings',
      'Next Actions',
    ]);
    expect(catalog.audience).toBe('internal stakeholders');
    expect(catalog.output_format).toBe('structured document');
  });

  it('resolves the canonical report template defaults', () => {
    expect(resolvePromotedReportTemplateSections()).toEqual([
      'Summary',
      'Current State',
      'Findings',
      'Next Actions',
    ]);
    expect(resolvePromotedReportAudience()).toBe('internal stakeholders');
    expect(resolvePromotedReportOutputFormat()).toBe('structured document');
  });
});
