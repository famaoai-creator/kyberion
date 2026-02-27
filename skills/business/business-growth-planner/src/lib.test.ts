import { describe, it, expect } from 'vitest';
import {
  generateOKRs,
  analyzeMarketEntry,
  defineRevenueStreams,
  processBusinessPlan,
  BusinessInput,
} from './lib.js';

describe('business-growth-planner lib', () => {
  const mockInput: BusinessInput = {
    name: 'TestCorp',
    vision: 'Test Vision',
    objectives: ['Expand to Mars'],
    target_market: { size: 'large', tam: 2000000000 },
    competitive_landscape: 'fragmented',
    product_readiness: 'mvp',
    model: 'saas',
    has_api: true,
    has_data: true,
  };

  it('should generate OKRs correctly', () => {
    const okrs = generateOKRs(mockInput);
    expect(okrs).toHaveLength(1);
    expect(okrs[0].objective).toBe('Expand to Mars');
    expect(okrs[0].keyResults).toHaveLength(3);
  });

  it('should analyze market entry strategies correctly', () => {
    const strategies = analyzeMarketEntry(mockInput);
    expect(strategies.some((s) => s.strategy === 'Land & Expand')).toBe(true);
    expect(strategies.some((s) => s.strategy === 'Consolidation Play')).toBe(true);
    expect(strategies.some((s) => s.strategy === 'Product-Led Growth')).toBe(true);
  });

  it('should define revenue streams correctly', () => {
    const streams = defineRevenueStreams(mockInput);
    expect(streams.some((s) => s.stream === 'SaaS Subscriptions')).toBe(true);
    expect(streams.some((s) => s.stream === 'API Usage Fees')).toBe(true);
    expect(streams.some((s) => s.stream === 'Data Insights')).toBe(true);
  });

  it('should process full business plan', () => {
    const result = processBusinessPlan(mockInput);
    expect(result.company).toBe('TestCorp');
    expect(result.okrs).toHaveLength(1);
    expect(result.marketEntryStrategies.length).toBeGreaterThan(0);
    expect(result.recommendations.length).toBeGreaterThanOrEqual(3);
  });

  it('should handle empty input gracefully', () => {
    const emptyInput: BusinessInput = {};
    const result = processBusinessPlan(emptyInput);

    expect(result.company).toBe('Unknown Entity');
    expect(result.okrs).toHaveLength(0);
    expect(result.recommendations).toContain(
      'Define clear objectives in your input to generate OKRs'
    );
    expect(result.recommendations).toContain('Provide company name for a more personalized plan');
  });
});
