import { describe, expect, it } from 'vitest';
import type { ApprovalVetoWindow } from './approval-veto-window.js';
import {
  createFactoryDeliveryEnvelope,
  type FactoryDeliveryEnvelope,
  type FactoryMergeMode,
} from './factory-delivery-envelope.js';
import { evaluateFactoryMergeGate } from './factory-merge-gate.js';
import type { FactoryAutonomyPolicy } from './factory-policy.js';

const graduatedPolicy: FactoryAutonomyPolicy = {
  version: '1.0.0',
  tenants: {
    acme: {
      enabled: true,
      graduated_actions: ['pr_merge_low', 'pr_merge_medium', 'ci_autofix_attempt'],
    },
  },
};

function makeEnvelope(
  overrides: {
    merge_mode?: FactoryMergeMode;
    allowed_paths?: string[];
    max_ci_repair_attempts?: number;
  } = {}
): FactoryDeliveryEnvelope {
  return createFactoryDeliveryEnvelope({
    mission_id: 'MSN-MERGE-TEST',
    tenant_slug: 'acme',
    authority_kind: 'alignment_brief',
    alignment_approval_ref: 'apr-merge-test',
    development_branch: 'agent/factory-merge-test',
    scope_in: overrides.allowed_paths ?? ['docs/**', 'libs/core/example.ts', '**/*.test.ts'],
    allowed_paths: overrides.allowed_paths ?? [
      'docs/**',
      'libs/core/example.ts',
      '**/*.test.ts',
      'knowledge/product/governance/**',
    ],
    merge_mode: overrides.merge_mode ?? 'auto_low_risk',
    max_ci_repair_attempts: overrides.max_ci_repair_attempts ?? 3,
    issued_at: '2026-11-22T00:00:00.000Z',
  });
}

describe('factory-merge-gate', () => {
  it('auto-merges low-risk diffs only when envelope, CI, review, and tenant graduation all pass', () => {
    const envelope = makeEnvelope({ merge_mode: 'auto_low_risk' });
    const allowed = evaluateFactoryMergeGate({
      envelope,
      changed_paths: ['docs/guide.md', 'libs/core/example.test.ts'],
      ci_green: true,
      cross_provider_review_verified: true,
      repairs_used: 0,
      factory_policy: graduatedPolicy,
      operations_halted: false,
    });
    expect(allowed).toMatchObject({
      action: 'auto_merge',
      allowed: true,
      tier: 'low',
      action_id: 'pr_merge_low',
      effective_merge_mode: 'auto_low_risk',
      envelope_ok: true,
      gate_decision: 'auto',
      gate_shadow: false,
    });

    const ungraduated = evaluateFactoryMergeGate({
      envelope,
      changed_paths: ['docs/guide.md'],
      ci_green: true,
      cross_provider_review_verified: true,
      repairs_used: 0,
      factory_policy: { version: '1.0.0', tenants: {} },
      operations_halted: false,
    });
    expect(ungraduated).toMatchObject({
      action: 'escalate_human',
      allowed: false,
      tier: 'low',
      action_id: 'pr_merge_low',
      gate_shadow: true,
    });
  });

  it('tightens low-risk files onto veto_window when the envelope specifies veto_window', () => {
    const envelope = makeEnvelope({ merge_mode: 'veto_window' });
    const now = Date.parse('2026-11-22T02:00:00.000Z');
    const res = evaluateFactoryMergeGate({
      envelope,
      changed_paths: ['docs/guide.md'],
      ci_green: true,
      cross_provider_review_verified: true,
      repairs_used: 0,
      now,
      factory_policy: graduatedPolicy,
      operations_halted: false,
    });
    expect(res).toMatchObject({
      action: 'open_veto_window',
      allowed: false,
      tier: 'medium',
      action_id: 'pr_merge_medium',
      effective_merge_mode: 'veto_window',
      veto_state: 'awaiting_delivery',
    });
    expect(res.veto_window?.windowMinutes).toBe(120);

    const humanOnlyEnvelope = makeEnvelope({ merge_mode: 'human_only' });
    const humanOnly = evaluateFactoryMergeGate({
      envelope: humanOnlyEnvelope,
      changed_paths: ['docs/guide.md'],
      ci_green: true,
      cross_provider_review_verified: true,
      repairs_used: 0,
      factory_policy: graduatedPolicy,
      operations_halted: false,
    });
    expect(humanOnly).toMatchObject({
      action: 'escalate_human',
      allowed: false,
      tier: 'high',
      action_id: 'pr_merge_high',
      effective_merge_mode: 'human_only',
      envelope_ok: true,
    });
  });

  it('drives medium-risk PRs through veto window open -> counting -> undelivered/objected -> elapsed auto-merge', () => {
    const envelope = makeEnvelope({ merge_mode: 'auto_low_risk' });
    const t0 = Date.parse('2026-11-22T01:00:00.000Z');

    const opened = evaluateFactoryMergeGate({
      envelope,
      changed_paths: ['libs/core/example.ts'],
      files: [{ path: 'libs/core/example.ts', additions: 12, deletions: 4 }],
      ci_green: true,
      cross_provider_review_verified: true,
      repairs_used: 1,
      now: t0,
      factory_policy: graduatedPolicy,
      operations_halted: false,
    });
    expect(opened.action).toBe('open_veto_window');
    expect(opened.tier).toBe('medium');
    expect(opened.action_id).toBe('pr_merge_medium');
    expect(opened.veto_window?.windowMinutes).toBe(120);

    const countingWindow: ApprovalVetoWindow = {
      ...opened.veto_window!,
      deliveredAt: '2026-11-22T01:05:00.000Z',
      proceedsAt: '2026-11-22T03:05:00.000Z',
    };
    const waiting = evaluateFactoryMergeGate({
      envelope,
      changed_paths: ['libs/core/example.ts'],
      ci_green: true,
      cross_provider_review_verified: true,
      repairs_used: 1,
      veto_window: countingWindow,
      now: Date.parse('2026-11-22T02:00:00.000Z'),
      factory_policy: graduatedPolicy,
      operations_halted: false,
    });
    expect(waiting).toMatchObject({
      action: 'wait_veto_window',
      allowed: false,
      veto_state: 'counting',
    });

    const undelivered = evaluateFactoryMergeGate({
      envelope,
      changed_paths: ['libs/core/example.ts'],
      ci_green: true,
      cross_provider_review_verified: true,
      repairs_used: 1,
      veto_window: opened.veto_window!,
      now: t0 + 45 * 60_000,
      factory_policy: graduatedPolicy,
      operations_halted: false,
    });
    expect(undelivered).toMatchObject({
      action: 'escalate_human',
      allowed: false,
      veto_state: 'undelivered',
    });

    const shadowElapsed = evaluateFactoryMergeGate({
      envelope,
      changed_paths: ['libs/core/example.ts'],
      ci_green: true,
      cross_provider_review_verified: true,
      repairs_used: 1,
      veto_window: { ...countingWindow, shadow: true },
      now: Date.parse('2026-11-22T03:10:00.000Z'),
      factory_policy: graduatedPolicy,
      operations_halted: false,
    });
    expect(shadowElapsed).toMatchObject({
      action: 'escalate_human',
      allowed: false,
      veto_state: 'elapsed_shadow',
    });

    const objected = evaluateFactoryMergeGate({
      envelope,
      changed_paths: ['libs/core/example.ts'],
      ci_green: true,
      cross_provider_review_verified: true,
      repairs_used: 1,
      veto_window: countingWindow,
      veto_objected: true,
      now: Date.parse('2026-11-22T02:00:00.000Z'),
      factory_policy: graduatedPolicy,
      operations_halted: false,
    });
    expect(objected).toMatchObject({
      action: 'escalate_human',
      allowed: false,
      escalations: ['veto_objected'],
    });

    const elapsed = evaluateFactoryMergeGate({
      envelope,
      changed_paths: ['libs/core/example.ts'],
      ci_green: true,
      cross_provider_review_verified: true,
      repairs_used: 1,
      veto_window: countingWindow,
      now: Date.parse('2026-11-22T03:10:00.000Z'),
      factory_policy: graduatedPolicy,
      operations_halted: false,
    });
    expect(elapsed).toMatchObject({
      action: 'auto_merge',
      allowed: true,
      tier: 'medium',
      action_id: 'pr_merge_medium',
      effective_merge_mode: 'veto_window',
      veto_state: 'elapsed',
      gate_shadow: false,
    });
  });

  it('escalates high-risk paths, never_auto classes, repair cap exhaustion, missing evidence, tampered envelopes, and halts', () => {
    const envelope = makeEnvelope({ merge_mode: 'auto_low_risk', max_ci_repair_attempts: 3 });

    const highRisk = evaluateFactoryMergeGate({
      envelope,
      changed_paths: ['knowledge/product/governance/foo.json'],
      ci_green: true,
      cross_provider_review_verified: true,
      repairs_used: 0,
      factory_policy: graduatedPolicy,
      operations_halted: false,
    });
    expect(highRisk).toMatchObject({
      action: 'escalate_human',
      allowed: false,
      tier: 'high',
      action_id: 'pr_merge_high',
      envelope_ok: false,
    });

    const neverAuto = evaluateFactoryMergeGate({
      envelope,
      changed_paths: ['docs/guide.md'],
      ci_green: true,
      cross_provider_review_verified: true,
      repairs_used: 0,
      detected_classes: ['dependency_major'],
      factory_policy: graduatedPolicy,
      operations_halted: false,
    });
    expect(neverAuto).toMatchObject({
      action: 'escalate_human',
      allowed: false,
      tier: 'high',
      action_id: 'pr_merge_high',
    });

    const repairCapReached = evaluateFactoryMergeGate({
      envelope,
      changed_paths: ['docs/guide.md'],
      ci_green: true,
      cross_provider_review_verified: true,
      repairs_used: 3,
      max_repairs: 3,
      factory_policy: graduatedPolicy,
      operations_halted: false,
    });
    expect(repairCapReached).toMatchObject({
      action: 'escalate_human',
      allowed: false,
      escalations: ['repair_cap_reached'],
    });

    // repairs_used === 0 && max_repairs === 0 must not trigger repair_cap_reached
    const zeroRepairsZeroBudget = evaluateFactoryMergeGate({
      envelope: makeEnvelope({ merge_mode: 'auto_low_risk', max_ci_repair_attempts: 0 }),
      changed_paths: ['docs/guide.md'],
      ci_green: true,
      cross_provider_review_verified: true,
      repairs_used: 0,
      max_repairs: 0,
      factory_policy: graduatedPolicy,
      operations_halted: false,
    });
    expect(zeroRepairsZeroBudget.action).toBe('auto_merge');

    const missingReview = evaluateFactoryMergeGate({
      envelope,
      changed_paths: ['docs/guide.md'],
      ci_green: true,
      cross_provider_review_verified: false,
      repairs_used: 0,
      factory_policy: graduatedPolicy,
      operations_halted: false,
    });
    expect(missingReview).toMatchObject({
      action: 'escalate_human',
      allowed: false,
      escalations: ['cross_provider_review'],
    });

    const missingCi = evaluateFactoryMergeGate({
      envelope,
      changed_paths: ['docs/guide.md'],
      ci_green: false,
      cross_provider_review_verified: true,
      repairs_used: 0,
      factory_policy: graduatedPolicy,
      operations_halted: false,
    });
    expect(missingCi).toMatchObject({
      action: 'escalate_human',
      allowed: false,
      escalations: ['ci_green'],
    });

    const tampered = evaluateFactoryMergeGate({
      envelope: { ...envelope, max_ci_repair_attempts: 1 },
      changed_paths: ['docs/guide.md'],
      ci_green: true,
      cross_provider_review_verified: true,
      repairs_used: 0,
      factory_policy: graduatedPolicy,
      operations_halted: false,
    });
    expect(tampered).toMatchObject({
      action: 'escalate_human',
      allowed: false,
      envelope_ok: false,
      escalations: ['integrity_mismatch'],
    });

    const halted = evaluateFactoryMergeGate({
      envelope,
      changed_paths: ['docs/guide.md'],
      ci_green: true,
      cross_provider_review_verified: true,
      repairs_used: 0,
      factory_policy: graduatedPolicy,
      operations_halted: true,
    });
    expect(halted).toMatchObject({
      action: 'escalate_human',
      allowed: false,
      escalations: ['operations_halted'],
    });
  });
});
