import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('document-layouts', () => {
  it('exposes invoice body section order and compliance bullets in knowledge', () => {
    const layoutPath = pathResolver.rootResolve('knowledge/public/design-patterns/media-templates/document-layouts.json');
    const raw = safeReadFile(layoutPath, { encoding: 'utf8' }) as string;
    const catalog = JSON.parse(raw);
    const invoice = catalog.documents.invoice.templates['jp-qualified-invoice-standard'];
    const report = catalog.documents.report.templates['report-standard'];

    expect(invoice.body_sections).toEqual([
      'header',
      'issuer',
      'recipient',
      'items',
      'tax_summary',
      'totals',
      'payment',
      'notes',
      'compliance',
    ]);
    expect(invoice.compliance_bullets).toContain('・取引年月日');
    expect(invoice.labels.section_issuer).toBe('請求元');
    expect(invoice.labels.section_compliance).toBe('【適格請求書の記載事項】');
    expect(report.body_sections).toEqual([
      'title',
      'summary',
      'contents',
      'section',
      'callout',
      'bullet',
      'table',
    ]);
  });
});
