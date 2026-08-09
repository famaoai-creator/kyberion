import { describe, expect, it } from 'vitest';
import { collectMissionGateDocViolations } from './check_mission_gate_docs.js';

describe('check_mission_gate_docs', () => {
  it('accepts current operator-facing guidance', () => {
    expect(
      collectMissionGateDocViolations({
        'example.md': 'Use work-scope-policy.json for mandatory and accumulation triggers.',
      })
    ).toEqual([]);
  });

  it('detects retired Rule 7 and five-condition wording', () => {
    expect(
      collectMissionGateDocViolations({
        'fixture.md':
          'Per AGENTS.md Rule 7, mission when any 2 of the following hold: 5+ artifacts.',
      })
    ).toEqual(['fixture.md:1: retired mission-gate wording; use work-scope-policy.json']);
  });
});
