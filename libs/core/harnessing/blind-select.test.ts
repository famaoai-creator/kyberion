import { describe, expect, it } from 'vitest';
import { anonymizeOutcomes, applyBlindSelection, metricsFallbackSelector } from './blind-select.js';
import type { RunOutcome } from './probe-runner.js';

const out = (label: string, delivered: boolean, wall_ms = 100): RunOutcome => ({
  label,
  run_dir: `/tmp/${label}`,
  ok: true,
  delivered,
  exit_code: delivered ? 0 : 1,
  wall_ms,
  produced_files: delivered ? ['o.txt'] : [],
  error: delivered ? '' : 'exit=1',
  recorded_at: 't',
});

describe('anonymizeOutcomes', () => {
  const outcomes = [out('alpha', true), out('beta', false), out('gamma', true)];
  it('is deterministic for a seed and permutes across seeds', () => {
    const a = anonymizeOutcomes(outcomes, 42);
    const b = anonymizeOutcomes(outcomes, 42);
    const c = anonymizeOutcomes(outcomes, 7);
    expect(a.letterToLabel).toEqual(b.letterToLabel);
    expect(Object.values(a.letterToLabel).sort()).toEqual(['alpha', 'beta', 'gamma']);
    // different seed gives a (probably) different order — mapping still bijective
    expect(Object.values(c.letterToLabel).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });
  it('anonymized rows carry evidence but no labels', () => {
    const m = anonymizeOutcomes(outcomes, 1);
    expect(m.rows).toHaveLength(3);
    for (const row of m.rows) {
      expect(row).not.toHaveProperty('label');
      expect(['A', 'B', 'C']).toContain(row.letter);
    }
  });
});

describe('applyBlindSelection', () => {
  it('maps the chosen letter back to the label', () => {
    const outcomes = [out('fast', true, 10), out('slow', true, 900)];
    const rec = applyBlindSelection(outcomes, 5, metricsFallbackSelector)!;
    expect(rec.recommended_winner).toBe('fast');
    expect(rec.map.letterToLabel[rec.letter]).toBe('fast');
  });
  it('custom selector receives only anonymized rows', () => {
    const outcomes = [out('x', true), out('y', true)];
    let sawLabels = false;
    const rec = applyBlindSelection(outcomes, 3, (rows) => {
      sawLabels = rows.some((r) => 'label' in r);
      return 'A';
    })!;
    expect(sawLabels).toBe(false);
    expect(rec.method).toBe('heuristic_blind');
    expect(rec.recommended_winner).toBeDefined();
  });
});

describe('anonymizeOutcomes — scale', () => {
  it('stays bijective past 26 outcomes', () => {
    const many = Array.from({ length: 30 }, (_, i) => out(`c${i}`, true));
    const m = anonymizeOutcomes(many, 9);
    expect(Object.keys(m.letterToLabel)).toHaveLength(30);
    expect(new Set(Object.values(m.letterToLabel)).size).toBe(30);
  });
  it('scrubs the outcome label out of error text', () => {
    const o = { ...out('secret-name', false), error: 'secret-name blew up: exit=1' };
    const m = anonymizeOutcomes([o], 1);
    expect(m.rows[0].error).not.toContain('secret-name');
    expect(m.rows[0].error).toContain('[CANDIDATE]');
  });
});
