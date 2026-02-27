import { describe, it, expect } from 'vitest';
import {
  analyzeGaps,
  analyzePricing,
  processCompetitiveAnalysis,
  CompetitiveInput,
} from './lib.js';

describe('competitive-intel-strategist lib', () => {
  const mockInput: CompetitiveInput = {
    our_product: {
      name: 'OurSaaS',
      features: ['API', 'Dashboard', 'SSO'],
      pricing: { basic: 29, pro: 99 },
      strengths: ['Fast API'],
    },
    competitors: [
      {
        name: 'CompA',
        features: ['API', 'Mobile App', 'AI'],
        pricing: { basic: 39, pro: 129 },
        weaknesses: ['Slow API'],
      },
    ],
  };

  it('should analyze gaps and advantages correctly', () => {
    const analysis = analyzeGaps(mockInput.our_product, mockInput.competitors);
    expect(analysis.gaps.some((g) => g.feature === 'Mobile App')).toBe(true);
    expect(analysis.advantages.some((a) => a.feature === 'Dashboard')).toBe(true);
  });

  it('should analyze pricing correctly', () => {
    const pricing = analyzePricing(mockInput.our_product, mockInput.competitors);
    expect(pricing).toHaveLength(2);
    expect(pricing.find((p) => p.tier === 'basic')?.position).toBe('below_market');
  });

  it('should process full competitive analysis', () => {
    const result = processCompetitiveAnalysis(mockInput);
    expect(result.ourProduct).toBe('OurSaaS');
    expect(result.gapAnalysis.gaps.length).toBeGreaterThan(0);
    expect(result.strategies.length).toBeGreaterThan(0);
    expect(result.strategies[0].action).toBeDefined();
  });

  it('should handle zero competitors gracefully', () => {
    const noCompInput: CompetitiveInput = {
      our_product: mockInput.our_product,
      competitors: [],
    };
    const result = processCompetitiveAnalysis(noCompInput);
    expect(result.competitorCount).toBe(0);
    expect(result.strategies.some((s) => s.area === 'Market Research')).toBe(true);
  });

  it('should handle our product with no features', () => {
    const noFeatureInput: CompetitiveInput = {
      our_product: { name: 'EmptySaaS', features: [] },
      competitors: mockInput.competitors,
    };
    const result = processCompetitiveAnalysis(noFeatureInput);
    expect(result.gapAnalysis.advantages).toHaveLength(0);
    expect(result.gapAnalysis.gaps.length).toBeGreaterThan(0);
  });
});
