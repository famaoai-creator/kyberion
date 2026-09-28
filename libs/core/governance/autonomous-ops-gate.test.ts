import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import {
  evaluateAutonomousOpsAction,
  getAutonomousOpsPolicy,
  _resetAutonomousOpsPolicyCacheForTests,
} from './autonomous-ops-gate.js';

describe('autonomous-ops-gate', () => {
  const tmpDir = pathResolver.sharedTmp('autonomous-ops-policy-tests');
  const overridePath = `${tmpDir}/autonomous-ops-policy.json`;

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.KYBERION_AUTONOMOUS_OPS_POLICY_PATH;
    _resetAutonomousOpsPolicyCacheForTests();
  });

  it('loads the governed policy and classifies actions', () => {
    const policy = getAutonomousOpsPolicy();
    expect(policy.version).toBe('1.1.0');

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
    _resetAutonomousOpsPolicyCacheForTests();

    const overridePolicy = getAutonomousOpsPolicy();
    expect(overridePolicy.version).toBe('override');
    expect(
      evaluateAutonomousOpsAction({ actionId: 'custom_action', executionMode: 'apply' }).decision
    ).toBe('auto');

    safeWriteFile(overridePath, '{invalid json');
    _resetAutonomousOpsPolicyCacheForTests();
    const degraded = evaluateAutonomousOpsAction({ actionId: 'custom_action' });
    expect(degraded.decision).toBe('approve');
    expect(degraded.allowed).toBe(false);
    expect(degraded.reason).toContain('unavailable or invalid');
  });

  it('fails closed when the policy file is missing', () => {
    vi.stubEnv('KYBERION_AUTONOMOUS_OPS_POLICY_PATH', `${tmpDir}/missing-policy.json`);
    _resetAutonomousOpsPolicyCacheForTests();

    const degraded = evaluateAutonomousOpsAction({ actionId: 'baseline_health_scan' });
    expect(degraded.decision).toBe('approve');
    expect(degraded.allowed).toBe(false);
    expect(degraded.reason).toContain('unavailable or invalid');
  });

  it('keeps pre-matrix actions live with unchanged decisions', () => {
    const expected: Record<string, 'auto' | 'notify' | 'approve'> = {
      storage_janitor: 'approve',
      baseline_health_scan: 'auto',
      tenant_drift_watch: 'notify',
      dependency_vuln_scan: 'auto',
      auto_checkpoint: 'auto',
      daemon_restart: 'approve',
    };
    for (const [actionId, decision] of Object.entries(expected)) {
      const result = evaluateAutonomousOpsAction({ actionId, executionMode: 'apply' });
      expect({ actionId, decision: result.decision, shadow: result.shadow }).toEqual({
        actionId,
        decision,
        shadow: false,
      });
    }
  });

  it('registers matrix v2 actions in shadow mode so they never execute', () => {
    const policy = getAutonomousOpsPolicy();
    const matrixActions = Object.entries(policy.actions).filter(
      ([, action]) => action.action_class
    );
    expect(matrixActions.length).toBeGreaterThanOrEqual(13);
    for (const [actionId] of matrixActions) {
      const result = evaluateAutonomousOpsAction({ actionId, executionMode: 'apply' });
      expect({ actionId, shadow: result.shadow, allowed: result.allowed }).toEqual({
        actionId,
        shadow: true,
        allowed: false,
      });
    }

    const lowMerge = evaluateAutonomousOpsAction({
      actionId: 'pr_merge_low',
      changedPaths: ['docs/guide.md'],
    });
    expect(lowMerge.decision).toBe('auto');
    expect(lowMerge.requiredEvidence).toEqual(['ci_green', 'cross_provider_review']);
    expect(lowMerge.reason).toContain('shadow mode');

    const mediumMerge = evaluateAutonomousOpsAction({ actionId: 'pr_merge_medium' });
    expect(mediumMerge.decision).toBe('notify');
    expect(mediumMerge.vetoWindowMinutes).toBe(120);
  });

  it('forces approve when a change touches a high-risk path', () => {
    const cases: Array<[string, boolean]> = [
      ['libs/core/secure-io.ts', true],
      ['.github/workflows/ci.yml', true],
      ['libs/core/governance/approval-store-hygiene.ts', true],
      ['libs/core/organization/tenant-registry.ts', true],
      ['knowledge/product/governance/autonomous-ops-policy.json', true],
      ['./AGENTS.md', true],
      ['docs/../AGENTS.md', true],
      ['../outside-repo.ts', true],
      ['/etc/passwd', true],
      ['libs/core/nested/approval.ts', true],
      ['LIBS/Core/Secure-IO.ts', true],
      ['agents.md', true],
      ['C:\\repo\\AGENTS.md', true],
      ['\\\\server\\share\\x.ts', true],
      ['.github', true],
      ['libs/core/package.json', true],
      ['docs/guide.md', false],
      ['.githubx/workflow.yml', false],
    ];
    for (const [changedPath, highRisk] of cases) {
      const result = evaluateAutonomousOpsAction({
        actionId: 'pr_merge_low',
        changedPaths: [changedPath],
      });
      expect({ changedPath, decision: result.decision }).toEqual({
        changedPath,
        decision: highRisk ? 'approve' : 'auto',
      });
      if (highRisk) expect(result.escalations).toContain('high_risk_path');
    }
  });

  it('forces approve for never-auto classes and maxed axes', () => {
    expect(evaluateAutonomousOpsAction({ actionId: 'secret_mutation' }).decision).toBe('approve');

    const dependencyMajor = evaluateAutonomousOpsAction({
      actionId: 'ci_autofix_attempt',
      detectedClasses: ['dependency_major'],
    });
    expect(dependencyMajor.decision).toBe('approve');
    expect(dependencyMajor.escalations).toContain('never_auto');

    const highMerge = evaluateAutonomousOpsAction({ actionId: 'pr_merge_high' });
    expect(highMerge.decision).toBe('approve');
  });

  it('lets an agent raise the tier but never lower it', () => {
    const raised = evaluateAutonomousOpsAction({
      actionId: 'pr_merge_low',
      requestedDecision: 'approve',
    });
    expect(raised.decision).toBe('approve');
    expect(raised.escalations).toContain('requested');

    const notLowered = evaluateAutonomousOpsAction({
      actionId: 'pr_merge_medium',
      requestedDecision: 'auto',
    });
    expect(notLowered.decision).toBe('notify');
    expect(notLowered.escalations).not.toContain('requested');

    const invalid = evaluateAutonomousOpsAction({
      actionId: 'pr_merge_low',
      requestedDecision: 'yolo' as unknown as 'auto',
    });
    expect(invalid.decision).toBe('approve');
  });

  it('records approve rules even when the score alone already requires approval', () => {
    const janitor = evaluateAutonomousOpsAction({
      actionId: 'storage_janitor',
      changedPaths: ['AGENTS.md'],
      estimatedCostTokens: Number.MAX_SAFE_INTEGER,
    });
    expect(janitor.decision).toBe('approve');
    expect(janitor.escalations).toEqual(expect.arrayContaining(['high_risk_path', 'budget']));
    expect(janitor.reason).toContain('exceeds budget cap');
  });

  it('skips change-based rules in dry-run mode', () => {
    const dryRun = evaluateAutonomousOpsAction({
      actionId: 'baseline_health_scan',
      executionMode: 'dry_run',
      changedPaths: ['AGENTS.md'],
      detectedClasses: ['secret_mutation'],
    });
    expect(dryRun.decision).toBe('auto');
    expect(dryRun.escalations).toEqual([]);
  });

  it('requires at least notify for irreversible actions and treats tenant overrides as floors', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      overridePath,
      JSON.stringify({
        version: 'override',
        decision_thresholds: { auto_max_score: 3, notify_max_score: 6 },
        axis_weights: { scope: 1, reversibility: 1, sensitivity: 1, confidence: 1 },
        never_auto: ['secret_mutation'],
        actions: {
          irreversible: {
            title: 'Irreversible',
            description: 'Low score but hard to undo',
            axis_scores: { scope: 0, reversibility: 2, sensitivity: 0, confidence: 0 },
          },
          maxed: {
            title: 'Maxed',
            description: 'Low total but one axis at maximum',
            axis_scores: { scope: 0, reversibility: 0, sensitivity: 3, confidence: 0 },
          },
          quiet_secret: {
            title: 'Quiet secret',
            description: 'Low score in a never-auto class',
            axis_scores: { scope: 0, reversibility: 0, sensitivity: 0, confidence: 0 },
            action_class: 'secret_mutation',
          },
          guarded: {
            title: 'Guarded',
            description: 'Approve by score',
            axis_scores: { scope: 2, reversibility: 1, sensitivity: 2, confidence: 2 },
            budget_cap_tokens: 1000,
          },
        },
        tenant_overrides: {
          acme: {
            actions: {
              guarded: {
                axis_scores: { scope: 0, reversibility: 0, sensitivity: 0, confidence: 0 },
                budget_cap_tokens: 5000,
              },
              irreversible: {
                axis_scores: { scope: 2, reversibility: 2, sensitivity: 2, confidence: 1 },
              },
              tenant_only: {
                title: 'Tenant only',
                description: 'Not in the base policy',
                axis_scores: { scope: 0, reversibility: 0, sensitivity: 0, confidence: 0 },
              },
            },
          },
        },
      })
    );
    vi.stubEnv('KYBERION_AUTONOMOUS_OPS_POLICY_PATH', overridePath);
    _resetAutonomousOpsPolicyCacheForTests();

    const irreversible = evaluateAutonomousOpsAction({ actionId: 'irreversible' });
    expect(irreversible.score).toBe(2);
    expect(irreversible.decision).toBe('notify');
    expect(irreversible.escalations).toEqual(['irreversible']);

    const maxed = evaluateAutonomousOpsAction({ actionId: 'maxed' });
    expect(maxed.decision).toBe('approve');
    expect(maxed.escalations).toEqual(['axis_max']);

    const quietSecret = evaluateAutonomousOpsAction({ actionId: 'quiet_secret' });
    expect(quietSecret.decision).toBe('approve');
    expect(quietSecret.escalations).toEqual(['never_auto']);

    const relaxed = evaluateAutonomousOpsAction({ actionId: 'guarded', tenantSlug: 'acme' });
    expect(relaxed.axes).toEqual({ scope: 2, reversibility: 1, sensitivity: 2, confidence: 2 });
    expect(relaxed.decision).toBe('approve');
    expect(relaxed.budgetCapTokens).toBe(1000);

    const tightened = evaluateAutonomousOpsAction({ actionId: 'irreversible', tenantSlug: 'acme' });
    expect(tightened.axes).toEqual({ scope: 2, reversibility: 2, sensitivity: 2, confidence: 1 });
    expect(tightened.decision).toBe('approve');

    const tenantOnly = evaluateAutonomousOpsAction({ actionId: 'tenant_only', tenantSlug: 'acme' });
    expect(tenantOnly.decision).toBe('approve');
    expect(tenantOnly.allowed).toBe(false);
  });

  it('fails closed when the policy override is outside the repository', () => {
    vi.stubEnv(
      'KYBERION_AUTONOMOUS_OPS_POLICY_PATH',
      '/tmp/kyberion-autonomous-ops-policy-external.json'
    );
    _resetAutonomousOpsPolicyCacheForTests();

    const degraded = evaluateAutonomousOpsAction({ actionId: 'baseline_health_scan' });
    expect(degraded.decision).toBe('approve');
    expect(degraded.allowed).toBe(false);
    expect(degraded.reason).toContain('unavailable or invalid');
  });
});
