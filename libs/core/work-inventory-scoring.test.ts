import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import {
  loadWorkInventoryTaxonomy,
  type WorkInventoryEntry,
  type WorkInventoryStep,
} from './work-inventory.js';
import {
  calibrateFromOutcomes,
  defaultWorkInventoryCalibration,
  loadWorkInventoryCalibration,
  rankWorkInventoryCandidates,
  saveWorkInventoryCalibration,
  scoreWorkInventoryEntry,
  validateWorkInventoryCalibration,
  type WorkInventoryCalibration,
} from './work-inventory-scoring.js';

function step(overrides: Partial<WorkInventoryStep> = {}): WorkInventoryStep {
  return {
    step_id: 'S1',
    stage: 'act',
    verb: 'input',
    description: 'do the thing',
    data_sensitivity: 'internal',
    effects: [],
    method: { assigned: 'api', source: 'rule', rule_id: 'x', rationale: 'x' },
    ...overrides,
  };
}

function entry(overrides: Partial<WorkInventoryEntry> = {}): WorkInventoryEntry {
  return {
    schema_version: 'work-inventory.v1',
    entry_id: 'WI-20260922-a',
    title: 'test entry',
    scope: {},
    trigger: { kind: 'ad_hoc', description: 'test' },
    steps: [step()],
    status: 'candidate',
    created_at: '2026-09-22T00:00:00.000Z',
    updated_at: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

const taxonomy = loadWorkInventoryTaxonomy();

describe('scoreWorkInventoryEntry: runs_per_month basis', () => {
  it('uses observed per_week (max across kyberion_trace/desktop/browser) over self-report', () => {
    const result = scoreWorkInventoryEntry(
      entry({
        frequency: { per: 'week', count: 1 },
        observations: [
          {
            source: 'kyberion_trace',
            ref: 'r1',
            observed_at: '2026-09-01T00:00:00.000Z',
            metrics: { per_week: 3 },
          },
          {
            source: 'desktop_recording',
            ref: 'r2',
            observed_at: '2026-09-01T00:00:00.000Z',
            metrics: { per_week: 5 },
          },
          {
            source: 'self_report',
            ref: 'r3',
            observed_at: '2026-09-01T00:00:00.000Z',
            metrics: { per_week: 99 },
          },
        ],
      }),
      { taxonomy }
    );
    expect(result.basis.runs).toBe('observed');
    expect(result.components.runs_per_month).toBeCloseTo(5 * (52 / 12), 4);
  });

  it('falls back to self-report frequency when no observation carries per_week', () => {
    const result = scoreWorkInventoryEntry(entry({ frequency: { per: 'month', count: 4 } }), {
      taxonomy,
    });
    expect(result.basis.runs).toBe('self_report');
    expect(result.components.runs_per_month).toBe(4);
  });

  it('is 0 with basis none when neither observation nor frequency is present', () => {
    const result = scoreWorkInventoryEntry(entry(), { taxonomy });
    expect(result.basis.runs).toBe('none');
    expect(result.components.runs_per_month).toBe(0);
  });

  it('converts each self-report frequency unit to runs per month', () => {
    const perDay = scoreWorkInventoryEntry(entry({ frequency: { per: 'day', count: 1 } }), {
      taxonomy,
    });
    const perQuarter = scoreWorkInventoryEntry(entry({ frequency: { per: 'quarter', count: 3 } }), {
      taxonomy,
    });
    const perYear = scoreWorkInventoryEntry(entry({ frequency: { per: 'year', count: 12 } }), {
      taxonomy,
    });
    expect(perDay.components.runs_per_month).toBeCloseTo(21.7, 4);
    expect(perQuarter.components.runs_per_month).toBeCloseTo(1, 4);
    expect(perYear.components.runs_per_month).toBeCloseTo(1, 4);
  });
});

describe('scoreWorkInventoryEntry: effort_minutes basis', () => {
  it('prefers self-reported effort_minutes_per_run over observed duration', () => {
    const result = scoreWorkInventoryEntry(
      entry({
        effort_minutes_per_run: 15,
        observations: [
          {
            source: 'kyberion_trace',
            ref: 'r1',
            observed_at: '2026-09-01T00:00:00.000Z',
            metrics: { median_duration_ms: 600000 },
          },
        ],
      }),
      { taxonomy }
    );
    expect(result.basis.effort).toBe('self_report');
    expect(result.components.effort_minutes).toBe(15);
  });

  it('falls back to the max observed median_duration_ms when self-report is absent', () => {
    const result = scoreWorkInventoryEntry(
      entry({
        observations: [
          {
            source: 'kyberion_trace',
            ref: 'r1',
            observed_at: '2026-09-01T00:00:00.000Z',
            metrics: { median_duration_ms: 60000 },
          },
          {
            source: 'desktop_recording',
            ref: 'r2',
            observed_at: '2026-09-01T00:00:00.000Z',
            metrics: { median_duration_ms: 180000 },
          },
        ],
      }),
      { taxonomy }
    );
    expect(result.basis.effort).toBe('observed');
    expect(result.components.effort_minutes).toBe(3);
  });

  it('is 0 with basis none when neither self-report nor observed duration is present', () => {
    const result = scoreWorkInventoryEntry(entry(), { taxonomy });
    expect(result.basis.effort).toBe('none');
    expect(result.components.effort_minutes).toBe(0);
  });
});

describe('scoreWorkInventoryEntry: automatable_ratio, confidence, risk', () => {
  it('is 0 when the entry has no steps', () => {
    const result = scoreWorkInventoryEntry(entry({ steps: [] }), { taxonomy });
    expect(result.components.automatable_ratio).toBe(0);
  });

  it('averages method_automatable across steps', () => {
    const result = scoreWorkInventoryEntry(
      entry({
        steps: [
          step({ step_id: 'S1', method: { assigned: 'api', source: 'rule', rationale: 'x' } }),
          step({ step_id: 'S2', method: { assigned: 'human', source: 'rule', rationale: 'x' } }),
        ],
      }),
      { taxonomy }
    );
    // api=1, human=0 => mean 0.5
    expect(result.components.automatable_ratio).toBeCloseTo(0.5, 4);
  });

  it('uses the self_report default confidence when there are no observations', () => {
    const result = scoreWorkInventoryEntry(entry(), { taxonomy });
    expect(result.components.confidence).toBe(
      taxonomy.scoring_defaults.observation_source_confidence.self_report
    );
  });

  it('uses the max observed source confidence across observations', () => {
    const result = scoreWorkInventoryEntry(
      entry({
        observations: [
          { source: 'self_report', ref: 'r0', observed_at: '2026-09-01T00:00:00.000Z' },
          { source: 'kyberion_trace', ref: 'r1', observed_at: '2026-09-01T00:00:00.000Z' },
        ],
      }),
      { taxonomy }
    );
    expect(result.components.confidence).toBe(
      taxonomy.scoring_defaults.observation_source_confidence.kyberion_trace
    );
  });

  it('sums risk penalties for distinct effects across all steps', () => {
    const result = scoreWorkInventoryEntry(
      entry({
        steps: [
          step({
            step_id: 'S1',
            effects: ['money'],
            method: { assigned: 'human', source: 'rule', rationale: 'x' },
          }),
          step({
            step_id: 'S2',
            effects: ['approval'],
            method: { assigned: 'human', source: 'rule', rationale: 'x' },
          }),
          // duplicate effect must not be double-counted
          step({
            step_id: 'S3',
            effects: ['money'],
            method: { assigned: 'human', source: 'rule', rationale: 'x' },
          }),
        ],
      }),
      { taxonomy }
    );
    expect(result.components.risk).toBeCloseTo(
      taxonomy.scoring_defaults.risk_effect_penalty.money +
        taxonomy.scoring_defaults.risk_effect_penalty.approval,
      4
    );
  });

  it('caps risk at 1 even when penalties for all present effects sum above 1', () => {
    const inflatedTaxonomy = {
      ...taxonomy,
      scoring_defaults: {
        ...taxonomy.scoring_defaults,
        risk_effect_penalty: {
          money: 0.5,
          irreversible: 0.5,
          approval: 0.5,
          external_send: 0.5,
          personal_data: 0.5,
        },
      },
    };
    const result = scoreWorkInventoryEntry(
      entry({
        steps: [
          step({
            step_id: 'S1',
            effects: ['money', 'irreversible', 'approval'],
            method: { assigned: 'human', source: 'rule', rationale: 'x' },
          }),
        ],
      }),
      { taxonomy: inflatedTaxonomy }
    );
    // 0.5 * 3 = 1.5, capped to 1.
    expect(result.components.risk).toBe(1);
  });

  it('includes explanation lines with numbers and basis', () => {
    const result = scoreWorkInventoryEntry(
      entry({ frequency: { per: 'week', count: 2 }, effort_minutes_per_run: 10 }),
      { taxonomy }
    );
    expect(result.explanation.some((line) => line.startsWith('runs_per_month:'))).toBe(true);
    expect(result.explanation.some((line) => line.includes('self_report'))).toBe(true);
    expect(result.explanation.some((line) => line.startsWith('score:'))).toBe(true);
  });
});

describe('rankWorkInventoryCandidates', () => {
  function makeEntry(
    id: string,
    status: WorkInventoryEntry['status'],
    runsPerWeek: number
  ): WorkInventoryEntry {
    return entry({
      entry_id: id,
      status,
      frequency: { per: 'week', count: runsPerWeek },
      effort_minutes_per_run: 10,
    });
  }

  it('sorts descending by score', () => {
    const low = makeEntry('WI-20260922-low', 'candidate', 1);
    const high = makeEntry('WI-20260922-high', 'candidate', 20);
    const ranked = rankWorkInventoryCandidates([low, high], { taxonomy });
    expect(ranked.map((r) => r.entry_id)).toEqual(['WI-20260922-high', 'WI-20260922-low']);
  });

  it('breaks ties by entry_id ascending', () => {
    const a = makeEntry('WI-20260922-bbb', 'candidate', 5);
    const b = makeEntry('WI-20260922-aaa', 'candidate', 5);
    const ranked = rankWorkInventoryCandidates([a, b], { taxonomy });
    expect(ranked.map((r) => r.entry_id)).toEqual(['WI-20260922-aaa', 'WI-20260922-bbb']);
  });

  it('defaults to draft/confirmed/candidate and excludes promoted/retired', () => {
    const draft = makeEntry('WI-20260922-draft', 'draft', 5);
    const promoted = makeEntry('WI-20260922-promoted', 'promoted', 5);
    const retired = makeEntry('WI-20260922-retired', 'retired', 5);
    const ranked = rankWorkInventoryCandidates([draft, promoted, retired], { taxonomy });
    expect(ranked.map((r) => r.entry_id)).toEqual(['WI-20260922-draft']);
  });

  it('honors an explicit includeStatuses filter', () => {
    const promoted = makeEntry('WI-20260922-promoted', 'promoted', 5);
    const ranked = rankWorkInventoryCandidates([promoted], {
      taxonomy,
      includeStatuses: ['promoted'],
    });
    expect(ranked.map((r) => r.entry_id)).toEqual(['WI-20260922-promoted']);
  });

  it('applies limit after sorting', () => {
    const a = makeEntry('WI-20260922-a', 'candidate', 1);
    const b = makeEntry('WI-20260922-b', 'candidate', 20);
    const c = makeEntry('WI-20260922-c', 'candidate', 10);
    const ranked = rankWorkInventoryCandidates([a, b, c], { taxonomy, limit: 2 });
    expect(ranked.map((r) => r.entry_id)).toEqual(['WI-20260922-b', 'WI-20260922-c']);
  });

  it('flips order when a calibrated weight changes', () => {
    // Entry A: high frequency, low (but nonzero) automatable ratio.
    const entryA = entry({
      entry_id: 'WI-20260922-freq',
      frequency: { per: 'week', count: 20 },
      effort_minutes_per_run: 10,
      steps: [step({ method: { assigned: 'computer_operation', source: 'rule', rationale: 'x' } })],
    });
    // Entry B: low frequency, fully automatable.
    const entryB = entry({
      entry_id: 'WI-20260922-auto',
      frequency: { per: 'week', count: 1 },
      effort_minutes_per_run: 10,
      steps: [step({ method: { assigned: 'api', source: 'rule', rationale: 'x' } })],
    });

    const defaultRanked = rankWorkInventoryCandidates([entryA, entryB], { taxonomy });
    expect(defaultRanked[0].entry_id).toBe('WI-20260922-freq');

    const calibration: WorkInventoryCalibration = {
      ...defaultWorkInventoryCalibration({}, taxonomy, new Date('2026-09-22T00:00:00.000Z')),
      weights: {
        frequency: 0,
        effort: 1,
        automatable_ratio: 5,
        confidence: 1,
        risk_penalty: 1,
      },
    };
    const calibratedRanked = rankWorkInventoryCandidates([entryA, entryB], {
      taxonomy,
      calibration,
    });
    expect(calibratedRanked[0].entry_id).toBe('WI-20260922-auto');
  });
});

describe('calibration: schema validation and default', () => {
  it('accepts a well-formed calibration record', () => {
    const calibration = defaultWorkInventoryCalibration(
      {},
      taxonomy,
      new Date('2026-09-22T00:00:00.000Z')
    );
    expect(validateWorkInventoryCalibration(calibration)).toEqual({ valid: true, errors: [] });
  });

  it('rejects an out-of-range method_automatable value', () => {
    const calibration = defaultWorkInventoryCalibration(
      {},
      taxonomy,
      new Date('2026-09-22T00:00:00.000Z')
    );
    const invalid = {
      ...calibration,
      method_automatable: { ...calibration.method_automatable, api: 1.5 },
    };
    const result = validateWorkInventoryCalibration(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects an unexpected top-level property', () => {
    const calibration = defaultWorkInventoryCalibration(
      {},
      taxonomy,
      new Date('2026-09-22T00:00:00.000Z')
    );
    const invalid = { ...calibration, unexpected: 'nope' };
    const result = validateWorkInventoryCalibration(invalid);
    expect(result.valid).toBe(false);
  });

  it('seeds weights and method_automatable from taxonomy scoring_defaults', () => {
    const calibration = defaultWorkInventoryCalibration(
      { tenant_slug: 'acme-corp' },
      taxonomy,
      new Date('2026-09-22T00:00:00.000Z')
    );
    expect(calibration.weights).toEqual(taxonomy.scoring_defaults.weights);
    expect(calibration.method_automatable).toEqual(taxonomy.scoring_defaults.method_automatable);
    expect(calibration.scope).toEqual({ tenant_slug: 'acme-corp' });
    expect(calibration.history).toEqual([]);
  });
});

describe('calibration: storage (hermetic)', () => {
  const FIXTURE_PARENT = path.join(pathResolver.rootDir(), 'active', 'shared', 'tmp');
  let fixtureRoot = '';

  beforeEach(() => {
    fs.mkdirSync(FIXTURE_PARENT, { recursive: true });
    fixtureRoot = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'work-inventory-calibration-test-'));
  });

  afterEach(() => {
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = '';
  });

  it('returns the default calibration when nothing is saved yet', () => {
    const loaded = loadWorkInventoryCalibration(
      { tenant_slug: 'acme-corp' },
      { rootDir: fixtureRoot }
    );
    expect(loaded.schema_version).toBe('work-inventory-calibration.v1');
    expect(loaded.weights).toEqual(taxonomy.scoring_defaults.weights);
  });

  it('round-trips a saved calibration through load', () => {
    const calibration = defaultWorkInventoryCalibration(
      { tenant_slug: 'acme-corp' },
      taxonomy,
      new Date('2026-09-22T00:00:00.000Z')
    );
    const withTweak: WorkInventoryCalibration = {
      ...calibration,
      weights: { ...calibration.weights, frequency: 2 },
    };
    saveWorkInventoryCalibration(withTweak, { rootDir: fixtureRoot });
    const loaded = loadWorkInventoryCalibration(
      { tenant_slug: 'acme-corp' },
      { rootDir: fixtureRoot }
    );
    expect(loaded.weights.frequency).toBe(2);
    expect(loaded.scope).toEqual({ tenant_slug: 'acme-corp' });
  });

  it('round-trips a personal-scoped calibration', () => {
    const calibration = defaultWorkInventoryCalibration(
      {},
      taxonomy,
      new Date('2026-09-22T00:00:00.000Z')
    );
    saveWorkInventoryCalibration(calibration, { rootDir: fixtureRoot });
    const loaded = loadWorkInventoryCalibration({}, { rootDir: fixtureRoot });
    expect(loaded.scope).toEqual({});
  });

  it('refuses to save a calibration that fails schema validation', () => {
    const calibration = defaultWorkInventoryCalibration(
      {},
      taxonomy,
      new Date('2026-09-22T00:00:00.000Z')
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const invalid = {
      ...calibration,
      method_automatable: { ...calibration.method_automatable, api: 'nope' },
    } as any;
    expect(() => saveWorkInventoryCalibration(invalid, { rootDir: fixtureRoot })).toThrow(
      /Invalid work inventory calibration/
    );
  });
});

describe('calibrateFromOutcomes', () => {
  const now = new Date('2026-09-22T12:00:00.000Z');

  it('lowers method_automatable when realized underperforms predicted', () => {
    const base = defaultWorkInventoryCalibration({}, taxonomy, now);
    const next = calibrateFromOutcomes(
      base,
      [
        {
          entry_id: 'WI-1',
          method_mix: { computer_operation: 1 },
          predicted_automatable_ratio: 0.6,
          realized_automatable_ratio: 0.3,
        },
      ],
      { now, reason: 'promotion outcome below prediction' }
    );
    expect(next.method_automatable.computer_operation).toBeLessThan(
      base.method_automatable.computer_operation
    );
  });

  it('raises method_automatable when realized exceeds predicted', () => {
    const base = defaultWorkInventoryCalibration({}, taxonomy, now);
    const next = calibrateFromOutcomes(
      base,
      [
        {
          entry_id: 'WI-1',
          method_mix: { ai_reasoning: 1 },
          predicted_automatable_ratio: 0.5,
          realized_automatable_ratio: 0.9,
        },
      ],
      { now, reason: 'promotion outcome above prediction' }
    );
    expect(next.method_automatable.ai_reasoning).toBeGreaterThan(
      base.method_automatable.ai_reasoning
    );
  });

  it('never changes human even if present with a share in method_mix', () => {
    const base = defaultWorkInventoryCalibration({}, taxonomy, now);
    const next = calibrateFromOutcomes(
      base,
      [
        {
          entry_id: 'WI-1',
          method_mix: { human: 1 },
          predicted_automatable_ratio: 0.5,
          realized_automatable_ratio: 0.9,
        },
      ],
      { now, reason: 'human share present' }
    );
    expect(next.method_automatable.human).toBe(0);
    expect(next.history[next.history.length - 1].changes).toEqual({});
  });

  it('clamps the result to [0, 1]', () => {
    const base: WorkInventoryCalibration = {
      ...defaultWorkInventoryCalibration({}, taxonomy, now),
      method_automatable: {
        ...defaultWorkInventoryCalibration({}, taxonomy, now).method_automatable,
        computer_operation: 0.95,
      },
    };
    const next = calibrateFromOutcomes(
      base,
      [
        {
          entry_id: 'WI-1',
          method_mix: { computer_operation: 1 },
          predicted_automatable_ratio: 0.5,
          realized_automatable_ratio: 5, // wildly overshoots to push above 1
        },
      ],
      { now, reason: 'clamp check', learningRate: 1 }
    );
    expect(next.method_automatable.computer_operation).toBeLessThanOrEqual(1);
    expect(next.method_automatable.computer_operation).toBeGreaterThanOrEqual(0);
  });

  it('ignores samples with predicted_automatable_ratio <= 0', () => {
    const base = defaultWorkInventoryCalibration({}, taxonomy, now);
    const next = calibrateFromOutcomes(
      base,
      [
        {
          entry_id: 'WI-1',
          method_mix: { api: 1 },
          predicted_automatable_ratio: 0,
          realized_automatable_ratio: 0.9,
        },
      ],
      { now, reason: 'zero prediction ignored' }
    );
    expect(next.method_automatable).toEqual(base.method_automatable);
    expect(next.history[next.history.length - 1].changes).toEqual({});
  });

  it('records the change in history with the given reason', () => {
    const base = defaultWorkInventoryCalibration({}, taxonomy, now);
    const next = calibrateFromOutcomes(
      base,
      [
        {
          entry_id: 'WI-1',
          method_mix: { computer_operation: 1 },
          predicted_automatable_ratio: 0.6,
          realized_automatable_ratio: 0.3,
        },
      ],
      { now, reason: 'weekly recalibration' }
    );
    const last = next.history[next.history.length - 1];
    expect(last.reason).toBe('weekly recalibration');
    expect(last.at).toBe(now.toISOString());
    expect(Object.keys(last.changes)).toEqual(['method_automatable.computer_operation']);
  });

  it('caps history at 50 entries, dropping the oldest first', () => {
    let calibration = defaultWorkInventoryCalibration({}, taxonomy, now);
    for (let i = 0; i < 55; i += 1) {
      calibration = calibrateFromOutcomes(
        calibration,
        [
          {
            entry_id: `WI-${i}`,
            method_mix: { computer_operation: 1 },
            predicted_automatable_ratio: 0.6,
            realized_automatable_ratio: 0.3,
          },
        ],
        { now, reason: `iteration ${i}` }
      );
    }
    expect(calibration.history).toHaveLength(50);
    expect(calibration.history[0].reason).toBe('iteration 5');
    expect(calibration.history[49].reason).toBe('iteration 54');
  });

  it('is pure: does not mutate the input calibration', () => {
    const base = defaultWorkInventoryCalibration({}, taxonomy, now);
    const snapshot = JSON.parse(JSON.stringify(base));
    calibrateFromOutcomes(
      base,
      [
        {
          entry_id: 'WI-1',
          method_mix: { computer_operation: 1 },
          predicted_automatable_ratio: 0.6,
          realized_automatable_ratio: 0.3,
        },
      ],
      { now, reason: 'purity check' }
    );
    expect(base).toEqual(snapshot);
  });
});
