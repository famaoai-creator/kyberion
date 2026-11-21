import { describe, expect, it } from 'vitest';
import type { AutonomousOpsPolicy } from './autonomous-ops-gate.js';
import type { FactoryAutonomyPolicy } from './factory-policy.js';
import {
  classifyCiProofFailure,
  computeFactoryCiSignature,
  planFactoryCiAutofix,
  validateCiAutofixPatchGuard,
  type FactoryCiFailureRecord,
} from './factory-ci-autofix.js';

const graduatedPolicy: FactoryAutonomyPolicy = {
  version: '1.0.0',
  tenants: {
    acme: {
      enabled: true,
      graduated_actions: ['ci_autofix_attempt'],
    },
  },
};

const testOpsPolicy: AutonomousOpsPolicy = {
  version: '1.2.0',
  decision_thresholds: { auto_max_score: 3, notify_max_score: 6 },
  axis_weights: { scope: 1, reversibility: 1, sensitivity: 1, confidence: 1 },
  high_risk_paths: ['AGENTS.md', '**/package.json', 'knowledge/product/governance/*.json'],
  actions: {},
};

const driftFailure: FactoryCiFailureRecord = {
  class: 'generated-drift',
  signature: computeFactoryCiSignature(['generated-drift', 'cli-reference']),
  title: 'generated file drift in cli-reference',
  gate: 'cli-reference',
  next: ['pnpm kyberion resolve generated'],
  changed: ['docs/CLI_REFERENCE.md'],
};

const unitTestFailure: FactoryCiFailureRecord = {
  class: 'test-failure',
  signature: computeFactoryCiSignature(['test-failure', 'libs/core/example.test.ts']),
  title: 'test failed: example.test.ts',
  file: 'libs/core/example.test.ts',
  next: ['pnpm exec vitest run libs/core/example.test.ts'],
};

describe('factory-ci-autofix', () => {
  it('stays in shadow escalation by default and acts only when tenant ci_autofix_attempt is graduated', () => {
    const shadowDecision = planFactoryCiAutofix({
      failures: [driftFailure],
      priorSignatures: [],
      attemptsUsed: 0,
      tenantSlug: 'acme',
    });
    expect(shadowDecision.action).toBe('escalate_human');
    expect(shadowDecision.allowed).toBe(false);
    expect(shadowDecision.stop_reason).toBe('shadow_mode');

    const graduatedDrift = planFactoryCiAutofix({
      failures: [driftFailure],
      priorSignatures: [],
      attemptsUsed: 0,
      tenantSlug: 'acme',
      changedPaths: ['libs/core/example.ts'],
      factoryPolicy: graduatedPolicy,
    });
    expect(graduatedDrift.action).toBe('run_resolve_generated');
    expect(graduatedDrift.allowed).toBe(true);
    expect(graduatedDrift.next_commands).toContain('pnpm kyberion resolve generated');

    const graduatedRepair = planFactoryCiAutofix({
      failures: [unitTestFailure],
      priorSignatures: [],
      attemptsUsed: 1,
      tenantSlug: 'acme',
      changedPaths: ['libs/core/example.ts'],
      factoryPolicy: graduatedPolicy,
    });
    expect(graduatedRepair.action).toBe('queue_code_repair');
    expect(graduatedRepair.allowed).toBe(true);
    expect(graduatedRepair.effective_max_attempts).toBe(3);
  });

  it('stops on duplicate failure signatures, attempt cap, high-risk paths, and non-auto classes', () => {
    const duplicate = planFactoryCiAutofix({
      failures: [unitTestFailure],
      priorSignatures: [unitTestFailure.signature],
      attemptsUsed: 1,
      tenantSlug: 'acme',
      factoryPolicy: graduatedPolicy,
    });
    expect(duplicate.action).toBe('escalate_human');
    expect(duplicate.stop_reason).toBe('duplicate_failure_signature');

    const capped = planFactoryCiAutofix({
      failures: [unitTestFailure],
      priorSignatures: [],
      attemptsUsed: 3,
      tenantSlug: 'acme',
      factoryPolicy: graduatedPolicy,
    });
    expect(capped.action).toBe('escalate_human');
    expect(capped.stop_reason).toBe('attempt_cap_reached');

    const ratchet = planFactoryCiAutofix({
      failures: [
        {
          class: 'ratchet/registration',
          signature: 'aaaa1111bbbb',
          title: 'orphans ratchet grew',
          gate: 'orphans',
          next: ['pnpm check -- --only orphans'],
        },
      ],
      priorSignatures: [],
      attemptsUsed: 0,
      tenantSlug: 'acme',
      factoryPolicy: graduatedPolicy,
    });
    expect(ratchet.action).toBe('escalate_human');
    expect(ratchet.stop_reason).toBe('non_auto_failure_class');

    const highRisk = planFactoryCiAutofix({
      failures: [unitTestFailure],
      priorSignatures: [],
      attemptsUsed: 0,
      tenantSlug: 'acme',
      changedPaths: ['AGENTS.md'],
      factoryPolicy: graduatedPolicy,
    });
    expect(highRisk.action).toBe('escalate_human');
    expect(highRisk.stop_reason).toBe('high_risk_path');
  });

  it('routes transient infra failures to retry_ci_or_wait and classifies CI proofs deterministically', () => {
    const infra = classifyCiProofFailure({
      requiredChecks: ['CI / tests'],
      reasons: ['HTTP 503 / runner timed out before completion'],
    });
    expect(infra.class).toBe('infra');
    expect(infra.suspectedFlake).toBe(true);

    const retryDecision = planFactoryCiAutofix({
      failures: [infra],
      priorSignatures: [],
      attemptsUsed: 0,
      tenantSlug: 'acme',
      factoryPolicy: graduatedPolicy,
    });
    expect(retryDecision.action).toBe('retry_ci_or_wait');
    expect(retryDecision.allowed).toBe(true);

    const driftProof = classifyCiProofFailure({
      requiredChecks: ['CI / check (op-registry)'],
      reasons: ['op-registry freshness drift'],
    });
    expect(driftProof.class).toBe('generated-drift');

    const ratchetProof = classifyCiProofFailure({
      requiredChecks: ['CI / check'],
      reasons: ['baseline allowance exceeded'],
    });
    expect(ratchetProof.class).toBe('ratchet/registration');
  });

  it('detects anti-cheating violations and allows normal implementation fixes', () => {
    const clean = validateCiAutofixPatchGuard({
      changedPaths: ['libs/core/example.ts', 'libs/core/example.test.ts'],
      patchText: [
        '+++ b/libs/core/example.ts',
        '+export const value = 42;',
        '+++ b/libs/core/example.test.ts',
        '+  expect(value).toBe(42);',
      ].join('\n'),
      policy: testOpsPolicy,
    });
    expect(clean.ok).toBe(true);
    expect(clean.escalate_to_approve).toBe(false);

    const touchesBaseline = validateCiAutofixPatchGuard({
      changedPaths: ['knowledge/product/governance/orphan-baseline.json'],
      policy: testOpsPolicy,
    });
    expect(touchesBaseline.ok).toBe(false);
    expect(touchesBaseline.violations.map((v) => v.code)).toContain('touches_baseline_or_config');

    const skipsAndWeakens = validateCiAutofixPatchGuard({
      changedPaths: ['libs/core/example.test.ts'],
      patchText: [
        '+++ b/libs/core/example.test.ts',
        '-  expect(actual).toBe(expected);',
        `+  // ${'@'}ts-ignore`,
        '+  it.skip("broken", () => {});',
      ].join('\n'),
      policy: testOpsPolicy,
    });
    expect(skipsAndWeakens.ok).toBe(false);
    expect(skipsAndWeakens.violations.map((v) => v.code)).toEqual(
      expect.arrayContaining(['weakens_or_skips_checks', 'removes_test_assertions'])
    );
  });
});
