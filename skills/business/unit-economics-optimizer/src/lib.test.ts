import { describe, it, expect } from 'vitest';
import {
  calculateLTV,
  analyzeSegment,
  generateRecommendations,
  processUnitEconomics,
  CustomerSegment,
} from './lib.js';

describe('unit-economics-optimizer lib', () => {
  const mockSegments: CustomerSegment[] = [
    {
      name: 'Basic',
      monthly_price: 20,
      cac: 200,
      churnRate: 0.1,
      grossMargin: 0.8,
      customer_count: 100,
    },
    {
      name: 'Enterprise',
      monthly_price: 500,
      cac: 1000,
      churnRate: 0.02,
      grossMargin: 0.9,
      customer_count: 10,
    },
  ];

  it('should calculate LTV correctly', () => {
    // 20 * 0.8 * (1 / 0.1) = 160
    const ltv = calculateLTV(mockSegments[0]);
    expect(ltv).toBe(160);
  });

  it('should analyze segment health based on LTV/CAC', () => {
    const basicAnalysis = analyzeSegment(mockSegments[0]);
    // LTV 160 / CAC 200 = 0.8 (< 1)
    expect(basicAnalysis.ltvCacRatio).toBe(0.8);
    expect(basicAnalysis.health).toBe('unprofitable');

    const entAnalysis = analyzeSegment(mockSegments[1]);
    // LTV (500 * 0.9 * 50) = 22500. 22500 / 1000 = 22.5
    expect(entAnalysis.ltvCacRatio).toBe(22.5);
    expect(entAnalysis.health).toBe('healthy');
  });

  it('should generate recommendations for risky segments', () => {
    const analyses = mockSegments.map(analyzeSegment);
    const recs = generateRecommendations(analyses);
    expect(recs.some((r) => r.segment === 'Basic' && r.priority === 'critical')).toBe(true);
    expect(recs.some((r) => r.segment === 'Portfolio')).toBe(true);
  });

  it('should process full unit economics portfolio', () => {
    const result = processUnitEconomics(mockSegments);
    expect(result.portfolio.totalMRR).toBe(20 * 100 + 500 * 10); // 2000 + 5000 = 7000
    expect(result.portfolio.weightedLtvCacRatio).toBeDefined();
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it('should cap LTV when churn is zero or near zero', () => {
    const perfectSegment: CustomerSegment = {
      name: 'Perfect',
      monthly_price: 100,
      churnRate: 0, // Should be capped at 0.001
      grossMargin: 1.0,
    };
    const ltv = calculateLTV(perfectSegment);
    expect(ltv).toBe(100000); // 100 * 1.0 * (1 / 0.001)
  });
});
