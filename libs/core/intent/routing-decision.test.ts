import { describe, expect, it } from 'vitest';
import { isRoutingDecision } from '../contracts/routing-decision.js';
import { resolveWorkScopeDecision } from '../workforce/work-scope-decision.js';
import { resolveIntentResolutionContract } from './intent-resolution-contract.js';
import { buildRoutingDecision, resolveRoutingDecision } from './routing-decision.js';

describe('RoutingDecision (D7, R2)', () => {
  it('emits intent, shape, authority, delivery mode and promotion for a selected intent', () => {
    const { packet, decision } = resolveRoutingDecision('サービスを停止して');
    const contract = resolveIntentResolutionContract(packet.utterance, { packet });

    expect(isRoutingDecision(decision)).toBe(true);
    expect(decision).toMatchObject({
      kind: 'routing_decision',
      intent_id: 'stop-service',
      execution_shape: contract.execution_shape,
      authority_level: contract.authority_level,
    });
    expect(decision.promotion.required).toBe(false);
    expect(decision.promotion.execution_shape).toBe(decision.execution_shape);
  });

  it('takes the promotion verdict from work-scope-policy.json', () => {
    const { decision } = resolveRoutingDecision('bootstrap-project');
    const verdict = resolveWorkScopeDecision({ catalogMinimumShape: decision.execution_shape });

    expect(decision.execution_shape).toBe('project_bootstrap');
    expect(decision.delivery_mode).toBe('managed_program');
    expect(decision.promotion).toMatchObject({
      required: true,
      execution_shape: verdict.execution_shape,
      matched_rule_ids: verdict.matched_rule_ids,
      policy_version: verdict.policy_version,
    });
    expect(decision.promotion.reasons[0]).toBe(verdict.rationale);
  });

  it('passes explicit work-scope facts to the policy and reports the triggers', () => {
    const { packet } = resolveRoutingDecision('サービスを停止して');
    const decision = buildRoutingDecision(packet, { workScope: { productionRelease: true } });

    expect(decision.promotion.required).toBe(true);
    expect(decision.promotion.execution_shape).toBe('mission');
    expect(decision.promotion.reasons).toContain('mandatory trigger: production_release');
  });

  it('asks for clarification when nothing was selected', () => {
    const { decision } = resolveRoutingDecision('qqzx vvlm 9137');

    expect(decision.intent_id).toBeUndefined();
    expect(decision.execution_shape).toBe('direct_reply');
    expect(decision.authority_level).toBe('human_clarification_required');
    expect(isRoutingDecision(decision)).toBe(true);
  });

  it('rejects values that are not a routing decision', () => {
    expect(isRoutingDecision(undefined)).toBe(false);
    expect(isRoutingDecision({ kind: 'intent_resolution_packet' })).toBe(false);
    expect(
      isRoutingDecision({
        kind: 'routing_decision',
        execution_shape: 'mission',
        authority_level: 'autonomous',
        delivery_mode: 'sometimes',
        promotion: { required: true, execution_shape: 'mission', reasons: [] },
      })
    ).toBe(false);
  });
});
