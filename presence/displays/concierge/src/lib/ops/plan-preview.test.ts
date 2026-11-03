import { describe, expect, it } from 'vitest';
import { buildPlanPreviewSignature, isPlanPreviewStale } from './plan-preview.js';

describe('plan preview signature', () => {
  it('tracks request fields and detects stale previews', () => {
    const previewSignature = buildPlanPreviewSignature({
      requestText: 'Ship the report',
      missionType: 'delivery',
      assignedPersona: 'operator',
      tier: 'confidential',
    });
    const sameSignature = buildPlanPreviewSignature({
      requestText: 'Ship the report',
      missionType: 'delivery',
      assignedPersona: 'operator',
      tier: 'confidential',
    });
    const changedSignature = buildPlanPreviewSignature({
      requestText: 'Ship the report now',
      missionType: 'delivery',
      assignedPersona: 'operator',
      tier: 'confidential',
    });

    expect(isPlanPreviewStale(previewSignature, sameSignature)).toBe(false);
    expect(isPlanPreviewStale(previewSignature, changedSignature)).toBe(true);
  });
});
