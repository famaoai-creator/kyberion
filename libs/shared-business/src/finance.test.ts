import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { calculateReinvestment } from './finance.js';

describe('calculateReinvestment()', () => {
  it('正の値に対して正しい計算結果を返す', () => {
    const result = calculateReinvestment(100);
    expect(result.reinvestableHours).toBe(70); // Math.round(100 * 0.7)
    expect(result.costAvoidanceUSD).toBe(10000); // 100 * 100
    expect(result.potentialFeatures).toBe('1.8'); // (70 / 40).toFixed(1)
  });

  it('0に対して0を返す', () => {
    const result = calculateReinvestment(0);
    expect(result.reinvestableHours).toBe(0);
    expect(result.costAvoidanceUSD).toBe(0);
  });

  it('potentialFeatures >= 1.0の場合、推奨メッセージを返す', () => {
    const result = calculateReinvestment(100);
    expect(result.recommendation).toContain('autonomous skills');
  });

  it('potentialFeatures < 1.0の場合、累積節約メッセージを返す', () => {
    const result = calculateReinvestment(10);
    expect(result.recommendation).toContain('cumulative savings');
  });

  // Feature: project-quality-improvement, Property 3: reinvestableHoursの上限不変条件
  describe('Property 3: reinvestableHoursの上限不変条件', () => {
    it('任意の非負整数に対してreinvestableHours <= savedHoursが成立する', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 100000 }), (savedHours) => {
          const result = calculateReinvestment(savedHours);
          expect(result.reinvestableHours).toBeLessThanOrEqual(savedHours);
        }),
        { numRuns: 100 }
      );
    });
  });

  // Feature: project-quality-improvement, Property 4: costAvoidanceUSDの線形性
  describe('Property 4: costAvoidanceUSDの線形性', () => {
    it('任意の非負整数に対してcostAvoidanceUSD = savedHours * 100が成立する', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 100000 }), (savedHours) => {
          const result = calculateReinvestment(savedHours);
          expect(result.costAvoidanceUSD).toBe(savedHours * 100);
        }),
        { numRuns: 100 }
      );
    });
  });
});
