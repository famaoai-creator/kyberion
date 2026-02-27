import { describe, it, expect } from 'vitest';
import {
  classifyDORA,
  calculateBusinessImpact,
  processImpactAnalysis,
  AnalysisInput,
} from './lib.js';

describe('business-impact-analyzer lib', () => {
  const mockInput: AnalysisInput = {
    dora: {
      deployment_frequency_per_week: 5,
      lead_time_hours: 24,
      change_failure_rate: 0.1,
      mttr_hours: 2,
    },
    quality: {
      error_rate_per_1000: 5,
      test_coverage: 0.75,
      tech_debt_hours: 200,
    },
    business: {
      hourly_revenue: 1000,
      developer_hourly_cost: 80,
      team_size: 10,
    },
  };

  it('should classify DORA metrics correctly', () => {
    const classification = classifyDORA(mockInput.dora!);
    expect(classification.metrics.deployment_frequency).toBe('high');
    expect(classification.metrics.lead_time).toBe('high');
    expect(classification.overallLevel).toBe('high');
  });

  it('should calculate business impact correctly', () => {
    const impact = calculateBusinessImpact(
      mockInput.dora!,
      mockInput.quality!,
      mockInput.business!
    );
    expect(impact.monthlyDowntimeCost).toBeGreaterThan(0);
    expect(impact.techDebtMonthlyCost).toBe(200 * 80);
    expect(impact.coverageRisk).toBe('high');
  });

  it('should process full impact analysis', () => {
    const result = processImpactAnalysis(mockInput);
    expect(result.doraClassification.overallLevel).toBe('high');
    expect(result.businessImpact.totalMonthlyImpact).toBeGreaterThan(0);
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it('should identify critical coverage risk', () => {
    const lowCoverageInput: AnalysisInput = {
      ...mockInput,
      quality: { ...mockInput.quality!, test_coverage: 0.5 },
    };
    const impact = calculateBusinessImpact(
      lowCoverageInput.dora!,
      lowCoverageInput.quality!,
      lowCoverageInput.business!
    );
    expect(impact.coverageRisk).toBe('critical');
  });

  it('should handle zero revenue gracefully', () => {
    const zeroRevInput: AnalysisInput = {
      ...mockInput,
      business: { ...mockInput.business!, hourly_revenue: 0 },
    };
    const result = processImpactAnalysis(zeroRevInput);
    expect(result.businessImpact.totalMonthlyImpact).toBe(
      result.businessImpact.techDebtMonthlyCost
    );
    expect(result.recommendations.some((r) => r.action.includes('Define hourly revenue'))).toBe(
      true
    );
  });

  it('should handle extreme MTTR values', () => {
    const extremeInput: AnalysisInput = {
      ...mockInput,
      dora: { ...mockInput.dora!, mttr_hours: 10000 },
    };
    const result = processImpactAnalysis(extremeInput);
    expect(result.doraClassification.metrics.mttr).toBe('low');
    expect(result.businessImpact.annualImpact).toBeGreaterThan(0);
  });
});
