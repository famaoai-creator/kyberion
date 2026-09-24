import { describe, expect, it } from 'vitest';
import {
  assertNotSimulatedEvidence,
  evidenceClassForProfile,
  simulatedEvidenceReason,
  SCENARIO_REPORT_SCHEMA_VERSION,
} from './scenario-evidence-class.js';

describe('scenario evidence class guard', () => {
  it('maps the execution profile onto the evidence class', () => {
    expect(evidenceClassForProfile('simulated')).toBe('simulated');
    expect(evidenceClassForProfile('provider-qualified')).toBe('provider-qualified');
  });

  it('rejects simulated evidence by class or profile', () => {
    expect(() => assertNotSimulatedEvidence({ evidence_class: 'simulated' }, 'intake')).toThrow(
      '[SIMULATED_EVIDENCE_REJECTED] intake'
    );
    expect(() =>
      assertNotSimulatedEvidence(
        { schema_version: SCENARIO_REPORT_SCHEMA_VERSION, executionProfile: 'simulated' },
        'intake'
      )
    ).toThrow('[SIMULATED_EVIDENCE_REJECTED]');
    expect(simulatedEvidenceReason({ execution_profile: 'simulated' })).toMatch(/simulated/);
  });

  it('rejects a scenario report that does not declare provider-qualified evidence', () => {
    expect(simulatedEvidenceReason({ schema_version: SCENARIO_REPORT_SCHEMA_VERSION })).toMatch(
      /without evidence_class/
    );
  });

  it('accepts provider-qualified reports and unrelated payloads', () => {
    expect(() =>
      assertNotSimulatedEvidence(
        {
          schema_version: SCENARIO_REPORT_SCHEMA_VERSION,
          executionProfile: 'provider-qualified',
          evidence_class: 'provider-qualified',
        },
        'intake'
      )
    ).not.toThrow();
    for (const value of [null, 'simulated', [], { id: 'x' }, { evidence_class: 'live' }]) {
      expect(() => assertNotSimulatedEvidence(value, 'intake')).not.toThrow();
    }
  });
});
