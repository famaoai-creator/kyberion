import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCOPE_AFFINITY,
  docAuthorityScore,
  recencyDecayScore,
  scopeAffinityScore,
} from './ranking-signals.js';

// KM-02 Task 4: these formulas were extracted verbatim from
// scripts/context_ranker.ts; the values below pin the pre-extraction
// behaviour so both rankers keep scoring identically.

describe('ranking-signals (KM-02)', () => {
  it('scopeAffinityScore matches the historical matrix values', () => {
    expect(scopeAffinityScore('mission', 'repository', 12)).toBe(Math.round(12 * 0.8));
    expect(scopeAffinityScore('global', 'environment', 12)).toBe(Math.round(12 * 0.2));
    expect(scopeAffinityScore('mission', 'mission', 12)).toBe(12);
  });

  it('scopeAffinityScore falls back to 0.4 for unknown scopes', () => {
    expect(scopeAffinityScore('mystery', 'mission', 10)).toBe(4);
    expect(scopeAffinityScore('mission', 'mystery', 10)).toBe(4);
  });

  it('docAuthorityScore walks the policy > standard > recipe > reference > advisory ladder', () => {
    expect(docAuthorityScore('policy', 8)).toBe(8);
    expect(docAuthorityScore('standard', 8)).toBe(7);
    expect(docAuthorityScore('recipe', 8)).toBe(6);
    expect(docAuthorityScore('reference', 8)).toBe(4);
    expect(docAuthorityScore('advisory', 8)).toBe(3);
    expect(docAuthorityScore('unknown-level', 8)).toBe(0);
  });

  it('docAuthorityScore never drops a recognised level below 1', () => {
    expect(docAuthorityScore('advisory', 2)).toBe(1);
    expect(docAuthorityScore('policy', 0)).toBe(0);
  });

  it('recencyDecayScore loses one point per 30 days and floors at 0', () => {
    const now = Date.UTC(2026, 6, 12);
    const day = 24 * 3600 * 1000;
    expect(recencyDecayScore(now, now)).toBe(10);
    expect(recencyDecayScore(now - 30 * day, now)).toBe(9);
    expect(recencyDecayScore(now - 600 * day, now)).toBe(0);
  });

  it('recencyDecayScore treats invalid dates as no recency signal (was NaN)', () => {
    expect(recencyDecayScore(Number.NaN, Date.now())).toBe(0);
  });

  it('exposes the affinity matrix for callers that need to extend it', () => {
    expect(DEFAULT_SCOPE_AFFINITY.repository.mission).toBe(0.8);
  });
});
