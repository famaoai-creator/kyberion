import { describe, expect, it } from 'vitest';
import type { AutonomousOpsPolicy } from './autonomous-ops-gate.js';
import type { MandateCatalog } from './mandate-shadow.js';
import {
  computeFactoryEnvelopeHash,
  createFactoryDeliveryEnvelope,
  createFactoryEnvelopeFromMandateBrief,
  evaluateDiffAgainstFactoryEnvelope,
  verifyFactoryEnvelopeIntegrity,
} from './factory-delivery-envelope.js';

const testPolicy: AutonomousOpsPolicy = {
  version: 'test',
  decision_thresholds: { auto_max_score: 3, notify_max_score: 6 },
  axis_weights: { scope: 1, reversibility: 1, sensitivity: 1, confidence: 1 },
  high_risk_paths: ['AGENTS.md', '**/package.json', 'libs/core/governance/autonomous-ops-gate.ts'],
  actions: {},
};

const testCatalog: MandateCatalog = {
  version: '1.0',
  external_effect_patterns: ['production deploy', 'drop database'],
  mandates: [
    {
      id: 'docs-update',
      title: 'Docs and tests update',
      work_type_patterns: ['documentation', 'docs update', 'unit test'],
      allowed_path_globs: ['docs/**', '**/*.test.ts', 'libs/core/example.ts'],
      max_risk_level: 2,
      expires_at: '2027-06-01T00:00:00.000Z',
    },
  ],
};

describe('factory-delivery-envelope', () => {
  it('creates an immutable hash-bound envelope and detects tampering', () => {
    const envelope = createFactoryDeliveryEnvelope({
      mission_id: 'MSN-FACTORY-1',
      tenant_slug: 'acme',
      authority_kind: 'alignment_brief',
      alignment_approval_ref: 'apr-001',
      development_branch: 'agent/factory-docs-01',
      scope_in: ['docs/**', 'libs/core/example.ts'],
      scope_out: ['docs/internal/**'],
      allowed_paths: ['docs/**', 'libs/core/example.ts'],
      merge_mode: 'veto_window',
      issued_at: '2026-11-21T00:00:00.000Z',
    });

    expect(Object.isFrozen(envelope)).toBe(true);
    expect(verifyFactoryEnvelopeIntegrity(envelope)).toBe(true);
    expect(
      verifyFactoryEnvelopeIntegrity({
        ...envelope,
        allowed_paths: ['**/*'],
      })
    ).toBe(false);
    expect(
      computeFactoryEnvelopeHash({
        version: 1,
        mission_id: envelope.mission_id,
        tenant_slug: envelope.tenant_slug,
        authority_kind: envelope.authority_kind,
        alignment_approval_ref: envelope.alignment_approval_ref,
        development_branch: envelope.development_branch,
        scope_in: envelope.scope_in,
        scope_out: envelope.scope_out,
        allowed_paths: envelope.allowed_paths,
        max_ci_repair_attempts: envelope.max_ci_repair_attempts,
        merge_mode: envelope.merge_mode,
        issued_at: envelope.issued_at,
      })
    ).toBe(envelope.envelope_sha256);
  });

  it('rejects unsafe paths, invalid branches, and missing authority references', () => {
    expect(() =>
      createFactoryDeliveryEnvelope({
        mission_id: 'MSN-BAD-1',
        authority_kind: 'standing_mandate',
        development_branch: 'agent/factory-bad',
        scope_in: ['docs/**'],
        allowed_paths: ['docs/**'],
        merge_mode: 'veto_window',
      })
    ).toThrow('mandate_id');

    expect(() =>
      createFactoryDeliveryEnvelope({
        mission_id: 'MSN-BAD-2',
        authority_kind: 'alignment_brief',
        alignment_approval_ref: 'apr-1',
        development_branch: 'main',
        scope_in: ['docs/**'],
        allowed_paths: ['docs/**'],
        merge_mode: 'veto_window',
      })
    ).toThrow('Invalid development branch');

    expect(() =>
      createFactoryDeliveryEnvelope({
        mission_id: 'MSN-BAD-3',
        authority_kind: 'alignment_brief',
        alignment_approval_ref: 'apr-1',
        development_branch: 'agent/factory-good',
        scope_in: ['../secret/**'],
        allowed_paths: ['docs/**'],
        merge_mode: 'veto_window',
      })
    ).toThrow('unsafe path segment');
  });

  it('creates an envelope from a covered mandate brief and rejects uncovered briefs', () => {
    const covered = createFactoryEnvelopeFromMandateBrief({
      mission_id: 'MSN-DOCS-1',
      tenant_slug: 'acme',
      development_branch: 'agent/factory-docs-01',
      merge_mode: 'auto_low_risk',
      catalog: testCatalog,
      now: new Date('2026-11-21T00:00:00.000Z'),
      brief: {
        tier: 'confidential',
        title: 'Documentation refresh',
        objective: 'Update docs for factory flow',
        scope: { in: ['docs/guide.md'], out: ['docs/archive/**'] },
        gate: { riskLevel: 1 },
      },
    });
    expect(covered.ok).toBe(true);
    if (covered.ok) {
      expect(covered.mandate_id).toBe('docs-update');
      expect(covered.envelope.authority_kind).toBe('standing_mandate');
      expect(verifyFactoryEnvelopeIntegrity(covered.envelope)).toBe(true);
    }

    const rejected = createFactoryEnvelopeFromMandateBrief({
      mission_id: 'MSN-DOCS-2',
      tenant_slug: 'acme',
      development_branch: 'agent/factory-docs-02',
      catalog: testCatalog,
      now: new Date('2026-11-21T00:00:00.000Z'),
      brief: {
        tier: 'confidential',
        title: 'Documentation refresh with production deploy',
        scope: { in: ['docs/guide.md'] },
        gate: { riskLevel: 1 },
      },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.reasons.join(' ')).toContain('external effect');
    }
  });

  it('enforces high_risk_paths, scope_out, allowed_paths, empty_diff, and integrity on diffs', () => {
    const envelope = createFactoryDeliveryEnvelope({
      mission_id: 'MSN-CHECK-1',
      tenant_slug: 'acme',
      authority_kind: 'alignment_brief',
      alignment_approval_ref: 'apr-2',
      development_branch: 'agent/factory-check-1',
      scope_in: ['docs/**', '**/*.test.ts', 'libs/core/example.ts'],
      scope_out: ['docs/secret/**'],
      allowed_paths: ['docs/**', '**/*.test.ts', 'libs/core/example.ts'],
      merge_mode: 'auto_low_risk',
    });

    const lowRiskOk = evaluateDiffAgainstFactoryEnvelope({
      envelope,
      changed_paths: ['docs/overview.md', 'libs/core/sample.test.ts'],
      policy: testPolicy,
    });
    expect(lowRiskOk.ok).toBe(true);
    expect(lowRiskOk.recommended_merge_mode).toBe('auto_low_risk');

    // Code file within allowed_paths tightens auto_low_risk -> veto_window.
    const tightenedOk = evaluateDiffAgainstFactoryEnvelope({
      envelope,
      changed_paths: ['libs/core/example.ts'],
      policy: testPolicy,
    });
    expect(tightenedOk.ok).toBe(true);
    expect(tightenedOk.recommended_merge_mode).toBe('veto_window');

    const empty = evaluateDiffAgainstFactoryEnvelope({
      envelope,
      changed_paths: [],
      policy: testPolicy,
    });
    expect(empty.ok).toBe(false);
    expect(empty.violations.map((v) => v.code)).toEqual(['empty_diff']);
    expect(empty.recommended_merge_mode).toBe('human_only');

    const highRisk = evaluateDiffAgainstFactoryEnvelope({
      envelope,
      changed_paths: ['AGENTS.md'],
      policy: testPolicy,
    });
    expect(highRisk.ok).toBe(false);
    expect(highRisk.violations.map((v) => v.code)).toContain('high_risk_path');

    const scopeOut = evaluateDiffAgainstFactoryEnvelope({
      envelope,
      changed_paths: ['docs/secret/notes.md'],
      policy: testPolicy,
    });
    expect(scopeOut.ok).toBe(false);
    expect(scopeOut.violations.map((v) => v.code)).toEqual(['scope_out']);

    const outsideAllowed = evaluateDiffAgainstFactoryEnvelope({
      envelope,
      changed_paths: ['scripts/unrelated.ts'],
      policy: testPolicy,
    });
    expect(outsideAllowed.ok).toBe(false);
    expect(outsideAllowed.violations.map((v) => v.code)).toEqual(['outside_allowed_paths']);

    const tampered = evaluateDiffAgainstFactoryEnvelope({
      envelope: { ...envelope, max_ci_repair_attempts: 0 },
      changed_paths: ['docs/overview.md'],
      policy: testPolicy,
    });
    expect(tampered.ok).toBe(false);
    expect(tampered.violations.map((v) => v.code)).toEqual(['integrity_mismatch']);
  });
});
