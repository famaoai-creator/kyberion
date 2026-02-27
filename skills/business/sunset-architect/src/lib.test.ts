import { describe, it, expect } from 'vitest';
import { planDeprecation, assessImpact, processSunsetPlans, FeatureData } from './lib.js';

describe('sunset-architect lib', () => {
  const mockFeatures: FeatureData[] = [
    {
      name: 'Legacy API v1',
      active_users: 1500,
      monthly_revenue: 6000,
      dependencies: ['mobile-app', 'partner-sync'],
    },
    {
      name: 'Unused Widget',
      active_users: 10,
      monthly_revenue: 0,
      dependencies: [],
    },
  ];

  it('should generate a 12-week deprecation timeline', () => {
    const timeline = planDeprecation('Test Feature');
    expect(timeline).toHaveLength(6);
    expect(timeline[0].phase).toBe('Announce');
    expect(timeline[5].week).toBe(12);
    expect(timeline[5].phase).toBe('Removal');
  });

  it('should assess impact and risk correctly', () => {
    const highRisk = assessImpact(mockFeatures[0]);
    expect(highRisk.risk).toBe('high');
    expect(highRisk.migrationComplexity).toBe('medium');

    const lowRisk = assessImpact(mockFeatures[1]);
    expect(lowRisk.risk).toBe('low');
    expect(lowRisk.migrationComplexity).toBe('low');
  });

  it('should process full sunset strategy', () => {
    const result = processSunsetPlans(mockFeatures);
    expect(result.featureCount).toBe(2);
    expect(result.totalAffectedUsers).toBe(1510);
    expect(result.totalRevenueImpact).toBe(6000);
    expect(result.recommendations.some((r) => r.priority === 'high')).toBe(true);
  });

  it('should warn when many features are sunset simultaneously', () => {
    const manyFeatures: FeatureData[] = [
      { name: 'F1' },
      { name: 'F2' },
      { name: 'F3' },
      { name: 'F4' },
    ];
    const result = processSunsetPlans(manyFeatures);
    expect(result.recommendations.some((r) => r.area === 'Customer Communication')).toBe(true);
  });
});
