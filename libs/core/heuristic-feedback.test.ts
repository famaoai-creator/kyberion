import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('./path-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('./path-resolver.js')>('./path-resolver.js');
  return { ...actual, rootResolve: vi.fn() };
});

vi.mock('./tier-guard.js', () => ({
  validateWritePermission: () => ({ allowed: true }),
  validateReadPermission: () => ({ allowed: true }),
  detectTier: () => 'confidential',
}));

vi.mock('./policy-engine.js', () => ({
  policyEngine: { evaluate: () => ({ allowed: true, action: 'allow' }) },
}));

import { rootResolve } from './path-resolver.js';
import {
  listHeuristics,
  readHeuristic,
  scoreValidity,
  summarizeHeuristics,
  validateHeuristic,
  type HeuristicEntry,
} from './heuristic-feedback.js';

describe('heuristic-feedback', () => {
  let tmpDir = '';
  const mockResolve = rootResolve as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heuristics-'));
    mockResolve.mockImplementation((rel: string) => path.join(tmpDir, rel));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function seed(entry: Partial<HeuristicEntry> & { id: string }): HeuristicEntry {
    const full: HeuristicEntry = {
      id: entry.id,
      captured_at: entry.captured_at ?? '2026-04-20T00:00:00Z',
      decision: entry.decision ?? 'pick option A',
      anchor: entry.anchor ?? 'option A',
      analogy: entry.analogy ?? 'last-year-acquisition',
      ...entry,
    };
    const dir = path.join(tmpDir, 'knowledge/confidential/heuristics');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${entry.id}.json`), JSON.stringify(full, null, 2));
    return full;
  }

  describe('scoreValidity', () => {
    it('maps success to 1.0', () => {
      expect(scoreValidity({ mission_id: 'm', completed_at: 't', result: 'success' })).toBe(1);
    });

    it('maps partial to 0.5', () => {
      expect(scoreValidity({ mission_id: 'm', completed_at: 't', result: 'partial' })).toBe(0.5);
    });

    it('maps failure to 0', () => {
      expect(scoreValidity({ mission_id: 'm', completed_at: 't', result: 'failure' })).toBe(0);
    });

    it('averages metric_score with base', () => {
      expect(
        scoreValidity({ mission_id: 'm', completed_at: 't', result: 'success', metric_score: 0.6 }),
      ).toBe(0.8);
    });

    it('ignores out-of-range metric_score', () => {
      expect(
        scoreValidity({ mission_id: 'm', completed_at: 't', result: 'success', metric_score: 1.5 }),
      ).toBe(1);
      expect(
        scoreValidity({ mission_id: 'm', completed_at: 't', result: 'failure', metric_score: -1 }),
      ).toBe(0);
    });
  });

  describe('validateHeuristic', () => {
    it('stamps a validation block', () => {
      seed({ id: 'h-1' });
      const updated = validateHeuristic({
        entryId: 'h-1',
        outcome: { mission_id: 'MSN-1', completed_at: '2026-04-25T00:00:00Z', result: 'success' },
      });
      expect(updated.validation?.validity_score).toBe(1);
      expect(updated.validation?.outcome_result).toBe('success');
      expect(updated.validation?.validated_at).toBeTruthy();
    });

    it('is idempotent (re-validation overwrites)', () => {
      seed({ id: 'h-2' });
      validateHeuristic({
        entryId: 'h-2',
        outcome: { mission_id: 'MSN-1', completed_at: 't', result: 'failure' },
      });
      const updated = validateHeuristic({
        entryId: 'h-2',
        outcome: { mission_id: 'MSN-1', completed_at: 't', result: 'success' },
      });
      expect(updated.validation?.validity_score).toBe(1);
    });

    it('throws for unknown entries', () => {
      expect(() =>
        validateHeuristic({
          entryId: 'missing',
          outcome: { mission_id: 'x', completed_at: 't', result: 'success' },
        }),
      ).toThrow(/not found/);
    });
  });

  describe('read helpers', () => {
    it('returns null for missing entry', () => {
      expect(readHeuristic('nope')).toBeNull();
    });

    it('lists all entries', () => {
      seed({ id: 'h-a' });
      seed({ id: 'h-b' });
      const entries = listHeuristics();
      expect(entries.map((e) => e.id).sort()).toEqual(['h-a', 'h-b']);
    });
  });

  describe('summarizeHeuristics', () => {
    it('reports counts and average for validated entries', () => {
      seed({ id: 'h-x' });
      seed({ id: 'h-y' });
      seed({ id: 'h-z' });
      validateHeuristic({
        entryId: 'h-x',
        outcome: { mission_id: 'a', completed_at: '2026-04-21T00:00:00Z', result: 'success' },
      });
      validateHeuristic({
        entryId: 'h-y',
        outcome: { mission_id: 'b', completed_at: '2026-04-22T00:00:00Z', result: 'partial' },
      });
      const report = summarizeHeuristics();
      expect(report.total).toBe(3);
      expect(report.validated).toBe(2);
      expect(report.unvalidated).toBe(1);
      expect(report.average_validity).toBe(0.75);
      expect(report.recent).toHaveLength(2);
    });

    it('returns null average when nothing is validated', () => {
      seed({ id: 'h-q' });
      const report = summarizeHeuristics();
      expect(report.total).toBe(1);
      expect(report.validated).toBe(0);
      expect(report.average_validity).toBeNull();
    });
  });
});
