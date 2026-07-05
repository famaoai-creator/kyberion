import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeMkdir, safeWriteFile } from '@agent/core';
import {
  evaluateAutonomousOpsAction,
  getAutonomousOpsPolicy,
  resetAutonomousOpsPolicyCache,
} from '../autonomous-ops-gate.js';

describe('autonomous-ops-gate', () => {
  const tmpDir = pathResolver.sharedTmp('autonomous-ops-policy-tests');
  const overridePath = `${tmpDir}/autonomous-ops-policy.json`;

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.KYBERION_AUTONOMOUS_OPS_POLICY_PATH;
    resetAutonomousOpsPolicyCache();
  });

  it('loads the governed policy and classifies actions', () => {
    const policy = getAutonomousOpsPolicy();
    expect(policy.version).toBe('1.0.0');

    const baseline = evaluateAutonomousOpsAction({ actionId: 'baseline_health_scan' });
    expect(baseline.decision).toBe('auto');
    expect(baseline.allowed).toBe(true);

    const driftWatch = evaluateAutonomousOpsAction({ actionId: 'tenant_drift_watch' });
    expect(driftWatch.decision).toBe('notify');
    expect(driftWatch.allowed).toBe(true);

    const janitor = evaluateAutonomousOpsAction({
      actionId: 'storage_janitor',
      executionMode: 'apply',
    });
    expect(janitor.decision).toBe('approve');
    expect(janitor.allowed).toBe(false);
  });

  it('treats dry-run maintenance as auto and budget overruns as approval', () => {
    const dryRun = evaluateAutonomousOpsAction({
      actionId: 'storage_janitor',
      executionMode: 'dry_run',
      estimatedCostTokens: 10_000,
    });
    expect(dryRun.decision).toBe('auto');
    expect(dryRun.allowed).toBe(true);

    const overBudget = evaluateAutonomousOpsAction({
      actionId: 'dependency_vuln_scan',
      executionMode: 'apply',
      estimatedCostTokens: 50_000,
    });
    expect(overBudget.decision).toBe('approve');
    expect(overBudget.allowed).toBe(false);
    expect(overBudget.reason).toContain('exceeds budget cap');
  });

  it('fails closed for unknown actions and invalid override policy files', () => {
    const unknown = evaluateAutonomousOpsAction({ actionId: 'does_not_exist' });
    expect(unknown.decision).toBe('approve');
    expect(unknown.allowed).toBe(false);

    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      overridePath,
      JSON.stringify(
        {
          version: 'override',
          decision_thresholds: { auto_max_score: 2, notify_max_score: 4 },
          axis_weights: { scope: 1, reversibility: 1, sensitivity: 1, confidence: 1 },
          actions: {
            custom_action: {
              title: 'Custom action',
              description: 'Custom policy for tests',
              axis_scores: { scope: 0, reversibility: 0, sensitivity: 0, confidence: 0 },
            },
          },
        },
        null,
        2
      )
    );
    vi.stubEnv('KYBERION_AUTONOMOUS_OPS_POLICY_PATH', overridePath);
    resetAutonomousOpsPolicyCache();

    const overridePolicy = getAutonomousOpsPolicy();
    expect(overridePolicy.version).toBe('override');
    expect(
      evaluateAutonomousOpsAction({ actionId: 'custom_action', executionMode: 'apply' }).decision
    ).toBe('auto');

    safeWriteFile(overridePath, '{invalid json');
    resetAutonomousOpsPolicyCache();
    const degraded = evaluateAutonomousOpsAction({ actionId: 'custom_action' });
    expect(degraded.decision).toBe('approve');
    expect(degraded.allowed).toBe(false);
    expect(degraded.reason).toContain('unavailable or invalid');
  });

  it('fails closed when the policy file is missing', () => {
    vi.stubEnv('KYBERION_AUTONOMOUS_OPS_POLICY_PATH', `${tmpDir}/missing-policy.json`);
    resetAutonomousOpsPolicyCache();

    const degraded = evaluateAutonomousOpsAction({ actionId: 'baseline_health_scan' });
    expect(degraded.decision).toBe('approve');
    expect(degraded.allowed).toBe(false);
    expect(degraded.reason).toContain('unavailable or invalid');
  });
});
