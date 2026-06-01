import { describe, expect, it } from 'vitest';

import {
  loadPromotedReportTemplatePolicyCatalog,
  resolvePromotedReportAudience,
  resolvePromotedReportOutputFormat,
  resolvePromotedReportTemplateSections,
} from './promoted-report-template-policy.js';

describe('promoted-report-template-policy', () => {
  it('loads the default report template policy', () => {
    const catalog = loadPromotedReportTemplatePolicyCatalog();
    expect(catalog.template_sections).toEqual(['Summary', 'Current State', 'Findings', 'Next Actions']);
    expect(catalog.audience).toBe('internal stakeholders');
    expect(catalog.output_format).toBe('structured document');
  });

  it('resolves the canonical report template defaults', () => {
    expect(resolvePromotedReportTemplateSections()).toEqual(['Summary', 'Current State', 'Findings', 'Next Actions']);
    expect(resolvePromotedReportAudience()).toBe('internal stakeholders');
    expect(resolvePromotedReportOutputFormat()).toBe('structured document');
  });
});
