import { describe, expect, it } from 'vitest';
import {
  buildPlanPreviewSignature,
  isPlanPreviewStale,
  planPreviewOrgRole,
} from './plan-preview.js';

describe('plan preview signature', () => {
  it('tracks request fields and detects stale previews', () => {
    const previewSignature = buildPlanPreviewSignature({
      requestText: 'Ship the report',
      missionType: 'delivery',
      orgRole: 'operator',
      tier: 'confidential',
    });
    const sameSignature = buildPlanPreviewSignature({
      requestText: 'Ship the report',
      missionType: 'delivery',
      orgRole: 'operator',
      tier: 'confidential',
    });
    const changedSignature = buildPlanPreviewSignature({
      requestText: 'Ship the report now',
      missionType: 'delivery',
      orgRole: 'operator',
      tier: 'confidential',
    });

    expect(isPlanPreviewStale(previewSignature, sameSignature)).toBe(false);
    expect(isPlanPreviewStale(previewSignature, changedSignature)).toBe(true);
  });
});

describe('plan preview Org Role input', () => {
  it('reads orgRole, and the pre-S4 assignedPersona for one release only when orgRole is absent', () => {
    expect(planPreviewOrgRole({ orgRole: 'qa_lead' })).toBe('qa_lead');
    expect(planPreviewOrgRole({ assignedPersona: 'qa_lead' })).toBe('qa_lead');
    expect(planPreviewOrgRole({ orgRole: 'qa_lead', assignedPersona: 'product_manager' })).toBe(
      'qa_lead'
    );
    expect(planPreviewOrgRole({ orgRole: 7, assignedPersona: 'product_manager' })).toBeUndefined();
    expect(planPreviewOrgRole({})).toBeUndefined();
    expect(planPreviewOrgRole(null)).toBeUndefined();
  });
});
