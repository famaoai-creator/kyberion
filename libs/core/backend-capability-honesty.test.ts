import { describe, expect, it } from 'vitest';
import {
  buildBackendCapabilityHonestyReport,
  formatBackendCapabilityHonestyReport,
} from './backend-capability-honesty.js';
import { BACKEND_CAPABILITY_PROFILES } from './backend-capability-profile.js';

const report = buildBackendCapabilityHonestyReport();

describe('backend capability honesty (TC-17)', () => {
  it('gives routing a profile for every mode the governed policy allows', () => {
    // A policy mode with no capability profile leaves routing with nothing to
    // consult about what that backend may be asked to do.
    expect(
      report.violations.filter((violation) => violation.kind === 'policy_mode_without_profile')
    ).toEqual([]);
  });

  it('attributes every judge claim to the reviewer probe', () => {
    const judgeClaims = report.claims.filter((claim) => claim.fit === 'judge');
    expect(judgeClaims.length).toBeGreaterThan(0);
    for (const claim of judgeClaims) {
      if (claim.verdict === 'unmeasurable') continue;
      expect(claim.evidence_role).toBe('reviewer');
    }
  });

  it('marks utilities with no probe as unmeasurable rather than proven', () => {
    // classify / summarize / divergent have no probe yet. Claiming them
    // "confirmed" on no evidence is the failure mode this report exists to
    // prevent, so they must read as unmeasurable.
    for (const claim of report.claims) {
      if (claim.fit === 'judge') continue;
      expect(claim.verdict).toBe('unmeasurable');
    }
  });

  it('covers every declared profile', () => {
    const declaredModes = Object.keys(BACKEND_CAPABILITY_PROFILES);
    const claimedModes = new Set(report.claims.map((claim) => claim.mode));
    for (const mode of declaredModes) {
      const profile = BACKEND_CAPABILITY_PROFILES[mode as keyof typeof BACKEND_CAPABILITY_PROFILES];
      if (profile.utility_fit.length === 0) continue;
      expect([...claimedModes]).toContain(mode);
    }
  });

  it('reports a profile the policy does not allow without failing on it', () => {
    // A declared-but-unreachable profile is drift worth seeing; it is not a
    // broken build, because the mode may simply be ahead of the policy.
    for (const mode of report.unreachable_profiles) {
      expect(report.policy_modes).not.toContain(mode);
      expect(report.violations.map((violation) => violation.mode)).not.toContain(mode);
    }
  });

  it('never lists the same model twice as evidence', () => {
    for (const claim of report.claims) {
      expect(new Set(claim.evidence_models).size).toBe(claim.evidence_models.length);
    }
  });

  it('renders a readable report', () => {
    const text = formatBackendCapabilityHonestyReport(report);
    expect(text).toContain('declared backend utility claims');
    expect(text).toContain('violations:');
  });
});
