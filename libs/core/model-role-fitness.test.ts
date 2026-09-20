import { describe, expect, it } from 'vitest';
import {
  evaluateRoleFitnessResponse,
  listRoleFitnessProbes,
  loadRoleFitnessProbeCatalog,
  normalizeFitnessProviderId,
  type RoleFitnessProbe,
} from './model-role-fitness.js';

const REVIEWER_PROBE = listRoleFitnessProbes('reviewer')[0]!;
const PLANNER_PROBE = listRoleFitnessProbes('planner')[0]!;

describe('role fitness probe catalog (TC-15)', () => {
  it('normalizes model catalog and backend provider identifiers', () => {
    expect(normalizeFitnessProviderId('anthropic')).toBe('claude');
    expect(normalizeFitnessProviderId('openai')).toBe('codex');
    expect(normalizeFitnessProviderId('xai')).toBe('grok');
    expect(normalizeFitnessProviderId('gemini-api')).toBe('gemini');
    expect(normalizeFitnessProviderId('  custom-provider ')).toBe('custom-provider');
    expect(normalizeFitnessProviderId(undefined)).toBeUndefined();
  });

  it('covers the roles a mission actually dispatches work to', () => {
    const roles = new Set(loadRoleFitnessProbeCatalog().probes.map((probe) => probe.team_role));
    for (const role of ['reviewer', 'planner', 'implementer', 'tester']) {
      expect([...roles]).toContain(role);
    }
  });

  it('states why each probe exists', () => {
    for (const probe of loadRoleFitnessProbeCatalog().probes) {
      expect(probe.rationale?.length || 0).toBeGreaterThan(20);
      expect(probe.assertions.length).toBeGreaterThan(1);
    }
  });
});

describe('role fitness scoring is mechanical (TC-15)', () => {
  it('passes a response that satisfies the contract and finds the defect', () => {
    const evaluation = evaluateRoleFitnessResponse(
      REVIEWER_PROBE,
      '[{"line": 3, "issue": "loop runs one past the end"}]'
    );
    expect(evaluation.passed).toBe(true);
    expect(evaluation.score).toBe(1);
  });

  it('fails a well-formed response that misses the defect', () => {
    // The contract is satisfied; the judgement is not. Structure alone must
    // not earn a pass.
    const evaluation = evaluateRoleFitnessResponse(
      REVIEWER_PROBE,
      '[{"line": 6, "issue": "returns a number"}]'
    );
    expect(evaluation.passed).toBe(false);
    expect(evaluation.assertions.find((entry) => entry.kind === 'field_equals_any')?.passed).toBe(
      false
    );
  });

  it('scores prose as a total miss rather than throwing', () => {
    const evaluation = evaluateRoleFitnessResponse(REVIEWER_PROBE, 'The loop looks wrong to me.');
    expect(evaluation.parsed).toBe(false);
    expect(evaluation.score).toBe(0);
    expect(evaluation.passed).toBe(false);
  });

  it('reads a fenced response', () => {
    const evaluation = evaluateRoleFitnessResponse(
      REVIEWER_PROBE,
      '```json\n[{"line": "3", "issue": "off by one"}]\n```'
    );
    expect(evaluation.passed).toBe(true);
  });

  it('rejects a task plan with an unresolvable dependency', () => {
    const evaluation = evaluateRoleFitnessResponse(
      PLANNER_PROBE,
      JSON.stringify([
        { id: 't1', title: 'design', depends_on: [] },
        { id: 't2', title: 'build', depends_on: ['t1'] },
        { id: 't3', title: 'verify', depends_on: ['t9'] },
      ])
    );
    const acyclic = evaluation.assertions.find((entry) => entry.kind === 'acyclic_dependencies');
    expect(acyclic?.passed).toBe(false);
    expect(acyclic?.detail).toContain('t9');
  });

  it('rejects a cyclic task plan', () => {
    const evaluation = evaluateRoleFitnessResponse(
      PLANNER_PROBE,
      JSON.stringify([
        { id: 't1', title: 'a', depends_on: ['t3'] },
        { id: 't2', title: 'b', depends_on: ['t1'] },
        { id: 't3', title: 'c', depends_on: ['t2'] },
      ])
    );
    expect(
      evaluation.assertions.find((entry) => entry.kind === 'acyclic_dependencies')?.passed
    ).toBe(false);
  });

  it('accepts a valid task plan', () => {
    const evaluation = evaluateRoleFitnessResponse(
      PLANNER_PROBE,
      JSON.stringify([
        { id: 't1', title: 'design limits', depends_on: [] },
        { id: 't2', title: 'implement middleware', depends_on: ['t1'] },
        { id: 't3', title: 'load test', depends_on: ['t2'] },
      ])
    );
    expect(evaluation.passed).toBe(true);
  });

  it('scores a partially compliant response between 0 and 1', () => {
    const probe: RoleFitnessProbe = {
      id: 'synthetic',
      team_role: 'reviewer',
      prompt: 'x',
      assertions: [
        { kind: 'json_array' },
        { kind: 'min_items', count: 5 },
        { kind: 'required_fields', fields: ['line'] },
      ],
    };
    const evaluation = evaluateRoleFitnessResponse(probe, '[{"line": 1}]');
    expect(evaluation.score).toBeCloseTo(2 / 3, 5);
    expect(evaluation.passed).toBe(false);
  });
});

describe('required assertions outrank structural compliance (TC-15)', () => {
  it('marks the judgement assertion required in every probe', () => {
    for (const probe of loadRoleFitnessProbeCatalog().probes) {
      expect(probe.assertions.some((assertion) => assertion.required)).toBe(true);
    }
  });

  it('reports which failing assertion was the required one', () => {
    const evaluation = evaluateRoleFitnessResponse(
      REVIEWER_PROBE,
      '[{"line": 6, "issue": "returns a number"}]'
    );
    // Three of four assertions still pass, so the score alone would clear the
    // threshold; the required one is what holds the gate.
    expect(evaluation.score).toBeGreaterThanOrEqual(0.75);
    expect(evaluation.passed).toBe(false);
    const failedRequired = evaluation.assertions.filter((entry) => entry.required && !entry.passed);
    expect(failedRequired).toHaveLength(1);
  });
});
