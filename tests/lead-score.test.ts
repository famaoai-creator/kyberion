import { describe, expect, it } from 'vitest';
import { scoreLead } from '../libs/core/lead-score.js';

describe('lead score', () => {
  it('scores a high-intent lead', () => {
    const result = scoreLead({
      has_budget: true,
      has_timeline: true,
      has_decision_maker: true,
      clear_pain: true,
      technical_fit: true,
      strategic_fit: true,
      wrong_fit_signal: false,
    });

    expect(result.grade).toBe('high_intent');
    expect(result.score).toBeGreaterThanOrEqual(75);
    expect(result.reasons).toContain('課題が明確');
  });

  it('scores an exploratory lead', () => {
    const result = scoreLead({
      has_budget: false,
      has_timeline: false,
      has_decision_maker: false,
      clear_pain: true,
      technical_fit: true,
      strategic_fit: false,
      wrong_fit_signal: false,
    });

    expect(result.grade).toBe('exploratory');
    expect(result.score).toBeGreaterThanOrEqual(30);
    expect(result.score).toBeLessThan(75);
  });

  it('scores a price-shopping lead', () => {
    const result = scoreLead({
      has_budget: true,
      has_timeline: false,
      has_decision_maker: false,
      clear_pain: false,
      technical_fit: false,
      strategic_fit: false,
      wrong_fit_signal: false,
    });

    expect(result.grade).toBe('price_shopping');
    expect(result.reasons).toContain('予算確認が先行している');
  });

  it('scores a wrong-fit lead', () => {
    const result = scoreLead({
      has_budget: false,
      has_timeline: false,
      has_decision_maker: false,
      clear_pain: false,
      technical_fit: false,
      strategic_fit: false,
      wrong_fit_signal: true,
    });

    expect(result.grade).toBe('wrong_fit');
    expect(result.score).toBeLessThanOrEqual(20);
    expect(result.reasons).toContain('不適合シグナルがある');
  });
});
