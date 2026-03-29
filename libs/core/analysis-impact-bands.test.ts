import { describe, expect, it } from 'vitest';
import { classifyAnalysisImpactBands } from './analysis-impact-bands.js';

describe('analysis-impact-bands', () => {
  it('classifies project-bound and incident refs into impact bands', () => {
    const items = classifyAnalysisImpactBands({
      refs: [
        'knowledge/public/incidents/post-mortem-20260228.md',
        'knowledge/public/common/patterns/generated/DSC-TEST.md',
        'active/projects/demo/tracks/TRK-1/requirements.md',
      ],
      projectId: 'PRJ-DEMO',
      trackId: 'TRK-1',
      reviewTarget: 'track:TRK-1',
    });

    expect(items.find((item) => item.ref.includes('TRK-1'))?.band).toBe('green');
    expect(items.find((item) => item.ref.includes('/incidents/'))?.band).toBe('amber');
    expect(items.find((item) => item.ref.includes('/patterns/'))?.band).toBe('gray');
  });
});
