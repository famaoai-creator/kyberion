import { describe, expect, it, beforeEach } from 'vitest';

import {
  loadReasoningLevelPolicy,
  resolveReasoningLevelDecision,
  resetReasoningLevelPolicyCache,
  validateReasoningLevelPolicy,
} from './reasoning-level-policy.js';

describe('reasoning-level-policy', () => {
  beforeEach(() => {
    resetReasoningLevelPolicyCache();
  });

  it('loads the policy catalog', () => {
    const policy = loadReasoningLevelPolicy();

    expect(policy.version).toBe('1.0.0');
    expect(policy.thresholds.low_confidence).toBe(0.65);
    expect(policy.fast_shapes).toEqual(['direct_reply', 'task_session']);
    expect(policy.task_model_routing?.phases.mechanical?.default.model_id).toBe(
      'openai:gpt-5.4-mini'
    );
    expect(policy.task_model_routing?.phases.plan?.scope?.S?.tier).toBe('standard');
  });

  it('routes greetings to the deterministic reflex lane', () => {
    const decision = resolveReasoningLevelDecision({
      isSimpleGreeting: true,
      resolutionPacket: {
        kind: 'intent_resolution_packet',
        utterance: 'こんにちは',
        candidates: [],
      },
    });

    expect(decision.level).toBe('REFLEX_DETERMINISTIC');
    expect(decision.rule_id).toBe('simple-greeting-reflex');
    expect(decision.advisory).toBe(true);
  });

  it('routes high-risk requests to exploratory reasoning', () => {
    const decision = resolveReasoningLevelDecision({
      isSimpleGreeting: false,
      resolutionPacket: {
        kind: 'intent_resolution_packet',
        utterance: 'approval task',
        selected_confidence: 0.9,
        candidates: [],
      },
      selectedIntent: {
        id: 'request-approval',
        risk_profile: 'approval_required',
        resolution: {
          shape: 'task_session',
        },
      },
    });

    expect(decision.level).toBe('COGNITIVE_EXPLORATORY');
    expect(decision.rule_id).toBe('high-risk-exploratory');
  });

  it('routes unresolved or low-confidence requests to exploratory reasoning', () => {
    const unresolvedDecision = resolveReasoningLevelDecision({
      isSimpleGreeting: false,
      resolutionPacket: {
        kind: 'intent_resolution_packet',
        utterance: 'please help',
        selected_confidence: undefined,
        candidates: [],
      },
    });
    expect(unresolvedDecision.level).toBe('COGNITIVE_EXPLORATORY');
    expect(unresolvedDecision.rule_id).toBe('ambiguous-exploratory');

    const lowConfidenceDecision = resolveReasoningLevelDecision({
      isSimpleGreeting: false,
      resolutionPacket: {
        kind: 'intent_resolution_packet',
        utterance: 'draft a quick note',
        selected_confidence: 0.6,
        candidates: [],
      },
      selectedIntent: {
        id: 'generate-note',
        risk_profile: 'low',
        resolution: {
          shape: 'direct_reply',
        },
      },
    });
    expect(lowConfidenceDecision.level).toBe('COGNITIVE_EXPLORATORY');
    expect(lowConfidenceDecision.rule_id).toBe('ambiguous-exploratory');
  });

  it('routes known low-risk direct requests to the fast lane', () => {
    const decision = resolveReasoningLevelDecision({
      isSimpleGreeting: false,
      resolutionPacket: {
        kind: 'intent_resolution_packet',
        utterance: 'answer quickly',
        selected_confidence: 0.9,
        candidates: [],
      },
      selectedIntent: {
        id: 'quick-reply',
        risk_profile: 'low',
        resolution: {
          shape: 'direct_reply',
        },
      },
    });

    expect(decision.level).toBe('REACTION_FAST');
    expect(decision.rule_id).toBe('known-low-risk-fast');
  });

  it('uses standard reasoning when no higher-priority rule matches', () => {
    const decision = resolveReasoningLevelDecision({
      isSimpleGreeting: false,
      resolutionPacket: {
        kind: 'intent_resolution_packet',
        utterance: 'plan a bounded task',
        selected_confidence: 0.8,
        candidates: [],
      },
      selectedIntent: {
        id: 'bounded-task',
        risk_profile: 'review_required',
        resolution: {
          shape: 'task_session',
        },
      },
    });

    expect(decision.level).toBe('COGNITIVE_STANDARD');
    expect(decision.rule_id).toBe('default-standard');
  });

  it('rejects invalid policy payloads through schema validation', () => {
    expect(() =>
      validateReasoningLevelPolicy({
        version: '1.0.0',
        thresholds: {
          low_confidence: 0.65,
        },
        fast_shapes: ['direct_reply'],
        rules: [],
      })
    ).toThrow(/Invalid reasoning level policy/);
  });
});
