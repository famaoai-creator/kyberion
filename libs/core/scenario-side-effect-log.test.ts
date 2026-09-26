import { describe, expect, it } from 'vitest';

import {
  appendScenarioOp,
  appendScenarioWarning,
  createScenarioSideEffectLog,
  MAX_SCENARIO_WARNINGS,
  scenarioWarningsDropped,
} from './scenario-side-effect-log.js';

describe('scenario side-effect log warnings (N5)', () => {
  it('gives warnings their own seq counter so host noise never shifts op seq', () => {
    const log = createScenarioSideEffectLog();
    const op1 = appendScenarioOp(log, { op: 'demo:apply', stage: 'apply', outcome: 'ok' });
    expect(op1.seq).toBe(1);

    const warning1 = appendScenarioWarning(log, {
      kind: 'scope_lost',
      op: 'unrelated:host',
      source: 'op-dispatch',
    });
    const warning2 = appendScenarioWarning(log, {
      kind: 'scope_lost',
      op: 'unrelated:host',
      source: 'op-dispatch',
    });

    // Interleaved warnings never consume an op seq: the next op record picks
    // up exactly where the previous one left off.
    const op2 = appendScenarioOp(log, { op: 'demo:apply', stage: 'apply', outcome: 'ok' });
    expect(op2.seq).toBe(2);

    // Warnings have their own independent, separately-monotonic sequence.
    expect(warning1.seq).toBe(1);
    expect(warning2.seq).toBe(2);
  });

  it('caps stored warning records and counts the rest as dropped', () => {
    const log = createScenarioSideEffectLog();
    for (let i = 0; i < MAX_SCENARIO_WARNINGS + 7; i += 1) {
      appendScenarioWarning(log, { kind: 'scope_lost', op: 'unrelated:host', source: 'pipeline' });
    }

    expect(log.warnings).toHaveLength(MAX_SCENARIO_WARNINGS);
    expect(scenarioWarningsDropped(log)).toBe(7);
    // Stored records keep contiguous seqs; the cap only stops storage, not counting.
    expect(log.warnings.at(-1)?.seq).toBe(MAX_SCENARIO_WARNINGS);
  });

  it('reports zero dropped warnings for a log under the cap', () => {
    const log = createScenarioSideEffectLog();
    appendScenarioWarning(log, { kind: 'scope_lost', op: 'demo:apply', source: 'pipeline' });
    expect(scenarioWarningsDropped(log)).toBe(0);
  });
});
