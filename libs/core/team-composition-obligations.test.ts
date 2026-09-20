import { describe, expect, it } from 'vitest';
import {
  loadTeamCompositionObligations,
  matchTeamCompositionObligations,
  resolveAlwaysStaffedRoles,
  resolveObligatoryRoles,
} from './team-composition-obligations.js';
import type { MissionClassification } from './mission-classification.js';

function classification(overrides: Partial<MissionClassification> = {}): MissionClassification {
  return {
    mission_class: 'code_change',
    delivery_shape: 'single_artifact',
    risk_profile: 'low',
    stage: 'execution',
    matched_rules: {},
    evidence: { normalized_artifact_paths: [], normalized_signals: [] },
    ...overrides,
  } as MissionClassification;
}

describe('team-composition-obligations (TC-03)', () => {
  it('declares the structural roles staffed from mission creation', () => {
    expect([...resolveAlwaysStaffedRoles()]).toEqual(['owner', 'orchestrator']);
  });

  it('requires no extra role for low-risk work', () => {
    expect(resolveObligatoryRoles({ classification: classification() })).toEqual([]);
  });

  it('requires an independent reviewer once risk reaches review_required', () => {
    const roles = resolveObligatoryRoles({
      classification: classification({ risk_profile: 'review_required' }),
    });
    expect(roles).toContain('reviewer');
  });

  it('ANDs facets within one rule', () => {
    // executed-verification needs BOTH a shipping mission class and elevated risk.
    const researchAtRisk = resolveObligatoryRoles({
      classification: classification({
        mission_class: 'research_and_absorption',
        risk_profile: 'review_required',
      }),
    });
    expect(researchAtRisk).not.toContain('tester');

    const codeChangeAtRisk = resolveObligatoryRoles({
      classification: classification({ risk_profile: 'review_required' }),
    });
    expect(codeChangeAtRisk).toContain('tester');
  });

  it('derives roles no template has to mention', () => {
    const roles = resolveObligatoryRoles({
      classification: classification({ mission_class: 'decision_support' }),
    });
    expect(roles).toContain('devils_advocate');
  });

  it('routes approvals to a human-facing role', () => {
    const roles = resolveObligatoryRoles({
      classification: classification({ risk_profile: 'approval_required' }),
    });
    expect(roles).toContain('surface_liaison');
  });

  it('requires an operator for cross-system change', () => {
    const roles = resolveObligatoryRoles({
      classification: classification({ delivery_shape: 'cross_system_change' }),
    });
    expect(roles).toContain('operator');
  });

  it('carries the reason of every matched obligation', () => {
    const matched = matchTeamCompositionObligations({
      classification: classification({ risk_profile: 'high_stakes' }),
    });
    expect(matched.length).toBeGreaterThan(0);
    for (const obligation of matched) {
      expect(obligation.id).toBeTruthy();
      expect(obligation.reason.length).toBeGreaterThan(20);
      expect(obligation.require_roles.length).toBeGreaterThan(0);
    }
  });

  it('orders the reviewer rule before the tester rule so separation stays resolvable', () => {
    const catalog = loadTeamCompositionObligations();
    const reviewerRule = catalog.obligations.findIndex((rule) =>
      rule.require_roles.includes('reviewer')
    );
    const testerRule = catalog.obligations.findIndex((rule) =>
      rule.require_roles.includes('tester')
    );
    expect(reviewerRule).toBeGreaterThanOrEqual(0);
    expect(testerRule).toBeGreaterThan(reviewerRule);
  });
});
