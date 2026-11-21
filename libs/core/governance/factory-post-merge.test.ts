import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync } from '../secure-io.js';
import { applyAutonomyOverride } from './autonomy-action-state.js';
import type { FactoryAutonomyPolicy } from './factory-policy.js';
import { buildFactoryConvergencePlan, planFactoryPostMergeRevert } from './factory-post-merge.js';

const graduatedPolicy: FactoryAutonomyPolicy = {
  version: '1.0.0',
  tenants: {
    acme: {
      enabled: true,
      graduated_actions: ['auto_revert_on_main_failure', 'pr_merge_low', 'pr_merge_medium'],
    },
  },
};

const VALID_SHA = 'a'.repeat(40);
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) safeRmSync(dir, { recursive: true, force: true });
  }
});

describe('factory-post-merge', () => {
  it('routes post-merge failures through noop -> rerun -> open_revert_pr and fail-closed escalations', () => {
    const noop = planFactoryPostMergeRevert({
      mission_id: 'MSN-POST-1',
      merge_commit_sha: VALID_SHA,
      incident_id: 'inc-1',
      main_ci_failed: false,
      failure_reproduced_on_rerun: false,
      revert_attempts_used: 0,
      tenant_slug: 'acme',
      factory_policy: graduatedPolicy,
    });
    expect(noop).toMatchObject({ action: 'noop', allowed: false, stop_reason: 'no_failure' });

    const badSha = planFactoryPostMergeRevert({
      mission_id: 'MSN-POST-2',
      merge_commit_sha: 'not-a-sha',
      incident_id: 'inc-2',
      main_ci_failed: true,
      failure_reproduced_on_rerun: true,
      revert_attempts_used: 0,
      tenant_slug: 'acme',
      factory_policy: graduatedPolicy,
    });
    expect(badSha).toMatchObject({
      action: 'escalate_human',
      allowed: false,
      stop_reason: 'invalid_merge_sha',
    });

    const rerun = planFactoryPostMergeRevert({
      mission_id: 'MSN-POST-3',
      merge_commit_sha: VALID_SHA,
      incident_id: 'inc-3',
      main_ci_failed: true,
      failure_reproduced_on_rerun: false,
      revert_attempts_used: 0,
      tenant_slug: 'acme',
      factory_policy: graduatedPolicy,
    });
    expect(rerun).toMatchObject({
      action: 'rerun_main_ci',
      allowed: false,
      stop_reason: 'rerun_required',
    });

    const revert = planFactoryPostMergeRevert({
      mission_id: 'MSN-POST-4',
      merge_commit_sha: VALID_SHA.toUpperCase(),
      incident_id: 'inc-4',
      main_ci_failed: true,
      failure_reproduced_on_rerun: true,
      revert_attempts_used: 0,
      changed_paths: ['libs/core/example.ts'],
      tenant_slug: 'acme',
      factory_policy: graduatedPolicy,
    });
    expect(revert).toMatchObject({
      action: 'open_revert_pr',
      allowed: true,
      revert_branch: `agent/factory-revert-${'a'.repeat(10)}`,
      revert_commit_message: `revert: revert ${'a'.repeat(10)} (MSN-POST-4)`,
      gate_shadow: false,
    });
    expect(revert.commands).toEqual([
      `git checkout -b agent/factory-revert-${'a'.repeat(10)} origin/main`,
      `git revert --no-edit ${VALID_SHA.toUpperCase()}`,
    ]);

    const conflict = planFactoryPostMergeRevert({
      mission_id: 'MSN-POST-5',
      merge_commit_sha: VALID_SHA,
      incident_id: 'inc-5',
      main_ci_failed: true,
      failure_reproduced_on_rerun: true,
      revert_attempts_used: 0,
      revert_conflict: true,
      tenant_slug: 'acme',
      factory_policy: graduatedPolicy,
    });
    expect(conflict).toMatchObject({
      action: 'escalate_human',
      allowed: false,
      stop_reason: 'revert_conflict',
    });

    const capped = planFactoryPostMergeRevert({
      mission_id: 'MSN-POST-6',
      merge_commit_sha: VALID_SHA,
      incident_id: 'inc-6',
      main_ci_failed: true,
      failure_reproduced_on_rerun: true,
      revert_attempts_used: 1,
      tenant_slug: 'acme',
      factory_policy: graduatedPolicy,
    });
    expect(capped).toMatchObject({
      action: 'escalate_human',
      allowed: false,
      stop_reason: 'attempt_cap_reached',
    });

    const highRisk = planFactoryPostMergeRevert({
      mission_id: 'MSN-POST-7',
      merge_commit_sha: VALID_SHA,
      incident_id: 'inc-7',
      main_ci_failed: true,
      failure_reproduced_on_rerun: true,
      revert_attempts_used: 0,
      changed_paths: ['knowledge/product/governance/factory-autonomy-policy.json'],
      tenant_slug: 'acme',
      factory_policy: graduatedPolicy,
    });
    expect(highRisk).toMatchObject({
      action: 'escalate_human',
      allowed: false,
      stop_reason: 'high_risk_path',
    });

    const shadow = planFactoryPostMergeRevert({
      mission_id: 'MSN-POST-8',
      merge_commit_sha: VALID_SHA,
      incident_id: 'inc-8',
      main_ci_failed: true,
      failure_reproduced_on_rerun: true,
      revert_attempts_used: 0,
      changed_paths: ['libs/core/example.ts'],
      tenant_slug: 'acme',
      factory_policy: { version: '1.0.0', tenants: {} },
    });
    expect(shadow).toMatchObject({
      action: 'escalate_human',
      allowed: false,
      stop_reason: 'shadow_mode',
      gate_shadow: true,
    });
  });

  it('records incident and demotes merge actions when apply_demotion is enabled', () => {
    const tmpDir = pathResolver.sharedTmp(
      `factory-post-merge-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    safeMkdir(tmpDir, { recursive: true });
    tempDirs.push(tmpDir);

    const fixedNow = new Date('2026-11-22T02:00:00.000Z');
    const deps = { rootDir: tmpDir, tenantSlug: 'acme', now: () => fixedNow };

    const res = planFactoryPostMergeRevert({
      mission_id: 'MSN-DEMOTE-1',
      merge_commit_sha: VALID_SHA,
      incident_id: 'inc-demote-1',
      main_ci_failed: true,
      failure_reproduced_on_rerun: true,
      revert_attempts_used: 0,
      changed_paths: ['libs/core/example.ts'],
      tenant_slug: 'acme',
      factory_policy: graduatedPolicy,
      apply_demotion: true,
      autonomy_state_deps: deps,
    });

    expect(res.action).toBe('open_revert_pr');
    expect(res.demotion_applied).toBe(true);
    expect(res.demoted_actions).toEqual(
      expect.arrayContaining(['pr_merge_low', 'pr_merge_medium'])
    );

    expect(applyAutonomyOverride('pr_merge_low', 'auto', [], deps)).toEqual({
      decision: 'approve',
      applied: 'demoted',
    });
    expect(applyAutonomyOverride('pr_merge_medium', 'notify', [], deps)).toEqual({
      decision: 'approve',
      applied: 'demoted',
    });
    expect(path.basename(tmpDir).startsWith('factory-post-merge-')).toBe(true);
  });

  it('builds post-merge convergence plans that protect non-terminal mission worktrees and shared branches', () => {
    const active = buildFactoryConvergencePlan({
      mission_id: 'MSN-CONV-1',
      mission_status: 'active',
      development_branch: 'agent/factory-conv-1',
      merge_commit_sha: VALID_SHA,
      worktree_path: '/tmp/wt-conv-1',
      main_ci_verified: true,
    });
    expect(active.ready_for_cleanup).toBe(false);
    expect(active.mission_terminal).toBe(false);
    expect(active.blocking_reasons[0]).toContain('non-terminal');
    expect(active.steps.find((s) => s.kind === 'finish_mission')?.eligible).toBe(true);
    expect(active.steps.find((s) => s.kind === 'sync_main')?.eligible).toBe(true);
    expect(active.steps.find((s) => s.kind === 'remove_worktree')?.eligible).toBe(false);
    expect(active.steps.find((s) => s.kind === 'delete_local_branch')?.eligible).toBe(false);

    const terminal = buildFactoryConvergencePlan({
      mission_id: 'MSN-CONV-2',
      mission_status: 'completed',
      development_branch: 'agent/factory-conv-2',
      merge_commit_sha: VALID_SHA,
      worktree_path: '/tmp/wt-conv-2',
      main_ci_verified: true,
    });
    expect(terminal.ready_for_cleanup).toBe(true);
    expect(terminal.blocking_reasons).toEqual([]);
    expect(terminal.steps.find((s) => s.kind === 'finish_mission')?.eligible).toBe(false);
    expect(terminal.steps.find((s) => s.kind === 'remove_worktree')?.eligible).toBe(true);
    expect(terminal.steps.find((s) => s.kind === 'delete_local_branch')?.eligible).toBe(true);
    expect(terminal.steps.find((s) => s.kind === 'delete_remote_branch')?.eligible).toBe(true);

    const legacyShared = buildFactoryConvergencePlan({
      mission_id: 'MSN-CONV-3',
      mission_status: 'completed',
      development_branch: 'agent/kyberion-development',
      merge_commit_sha: VALID_SHA,
      worktree_path: '/tmp/wt-legacy',
      main_ci_verified: true,
    });
    expect(legacyShared.ready_for_cleanup).toBe(true);
    expect(legacyShared.steps.some((s) => s.kind === 'delete_local_branch')).toBe(false);
    expect(legacyShared.steps.some((s) => s.kind === 'delete_remote_branch')).toBe(false);

    const unverified = buildFactoryConvergencePlan({
      mission_id: 'MSN-CONV-4',
      mission_status: 'completed',
      development_branch: 'agent/factory-conv-4',
      merge_commit_sha: undefined,
      worktree_path: '/tmp/wt-unverified',
      main_ci_verified: false,
    });
    expect(unverified.ready_for_cleanup).toBe(false);
    expect(unverified.steps.every((s) => !s.eligible)).toBe(true);
  });
});
