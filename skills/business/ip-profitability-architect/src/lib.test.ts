import { describe, it, expect } from 'vitest';
import { analyzeIPAssets, designLicensingModels, processIPStrategy, IPAsset } from './lib.js';

describe('ip-profitability-architect lib', () => {
  const mockAssets: IPAsset[] = [
    {
      name: 'Core AI Engine',
      type: 'software',
      development_cost: 100000,
      annual_maintenance: 10000,
      potential_annual_revenue: 250000,
    },
    {
      name: 'Legacy Parser',
      type: 'utility',
      development_cost: 20000,
      annual_maintenance: 5000,
      potential_annual_revenue: 10000,
    },
  ];

  it('should analyze IP assets and calculate ROI', () => {
    const analyzed = analyzeIPAssets(mockAssets);
    expect(analyzed).toHaveLength(2);
    expect(analyzed[0].roi).toBe(Math.round(((250000 - 10000) / 100000) * 100)); // 240%
    expect(analyzed[0].profitability).toBe('high');
    expect(analyzed[1].profitability).toBe('low');
  });

  it('should design licensing models for profitable assets', () => {
    const analyzed = analyzeIPAssets(mockAssets);
    const licensing = designLicensingModels(analyzed);
    expect(licensing).toHaveLength(1); // Only Core AI Engine is high/medium
    expect(licensing[0].asset).toBe('Core AI Engine');
    expect(licensing[0].models).toHaveLength(3);
  });

  it('should process full IP strategy', () => {
    const result = processIPStrategy(mockAssets);
    expect(result.assetCount).toBe(2);
    expect(result.portfolio.totalInvestment).toBe(100000 + 10000 + 20000 + 5000);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0].action).toContain('Core AI Engine');
  });

  it('should handle assets with zero development cost', () => {
    const freeAsset: IPAsset[] = [
      {
        name: 'OSS Library',
        development_cost: 0,
        annual_maintenance: 100,
        potential_annual_revenue: 5000,
      },
    ];
    const result = analyzeIPAssets(freeAsset);
    expect(result[0].roi).toBe(9999);
    expect(result[0].profitability).toBe('high');
  });
});
