import { describe, expect, it, beforeEach } from 'vitest';

import {
  loadReasoningLevelPolicy,
  resetReasoningLevelPolicyCache,
} from './reasoning-level-policy.js';
import {
  loadModelRegistry,
  resetReasoningModelRoutingCache,
  resolveReasoningModelRoute,
  resolveTaskModelHint,
  resolveRuntimeModelId,
} from './reasoning-model-routing.js';

describe('reasoning-model-routing', () => {
  beforeEach(() => {
    resetReasoningLevelPolicyCache();
    resetReasoningModelRoutingCache();
  });

  it('returns the expected shadow mapping for each reasoning level', () => {
    const policy = loadReasoningLevelPolicy();
    const registry = loadModelRegistry();

    expect(
      resolveReasoningModelRoute(
        {
          level: 'COGNITIVE_EXPLORATORY',
          rule_id: 'high-risk-exploratory',
          reasons: [],
          policy_version: policy.version,
          advisory: true,
        },
        { policy, registry }
      ).recommended_model_id
    ).toBe('openai:gpt-5.5');

    expect(
      resolveReasoningModelRoute(
        {
          level: 'COGNITIVE_STANDARD',
          rule_id: 'default-standard',
          reasons: [],
          policy_version: policy.version,
          advisory: true,
        },
        { policy, registry }
      ).recommended_model_id
    ).toBe('openai:gpt-5.5');

    expect(
      resolveReasoningModelRoute(
        {
          level: 'REACTION_FAST',
          rule_id: 'known-low-risk-fast',
          reasons: [],
          policy_version: policy.version,
          advisory: true,
        },
        { policy, registry }
      ).recommended_model_id
    ).toBe('openai:gpt-5.4-mini');

    expect(
      resolveReasoningModelRoute(
        {
          level: 'REFLEX_DETERMINISTIC',
          rule_id: 'simple-greeting-reflex',
          reasons: [],
          policy_version: policy.version,
          advisory: true,
        },
        { policy, registry }
      ).recommended_model_id
    ).toBeNull();
  });

  it('falls back to the approved primary model when the mini model is missing or ineligible', () => {
    const policy = loadReasoningLevelPolicy();
    const registry = {
      version: '1.0.0',
      default_model_id: 'openai:gpt-5.4',
      models: [
        {
          model_id: 'openai:gpt-5.4',
          provider: 'openai',
          family: 'gpt-5',
          status: 'approved' as const,
          role_fit: {
            intent_compiler: 'primary' as const,
            surface_agent: 'primary' as const,
            analysis: 'primary' as const,
            coding: 'primary' as const,
          },
        },
      ],
    };

    const route = resolveReasoningModelRoute(
      {
        level: 'REACTION_FAST',
        rule_id: 'known-low-risk-fast',
        reasons: [],
        policy_version: policy.version,
        advisory: true,
      },
      { policy, registry }
    );

    expect(route.recommended_model_id).toBe('openai:gpt-5.4');
    expect(route.route_kind).toBe('primary');
    expect(route.route_reason).toMatch(/fell back/i);
  });

  it('centralizes runtime model defaults and respects env overrides', () => {
    expect(resolveRuntimeModelId('anthropic-default', {})).toBe('claude-opus-4-8');
    expect(resolveRuntimeModelId('gemini-default', {})).toBe('gemini-3.5-flash');
    expect(resolveRuntimeModelId('openai-vision', {})).toBe('gpt-5.5');
    expect(resolveRuntimeModelId('codex-default', {})).toBe('gpt-5.5');

    expect(
      resolveRuntimeModelId('anthropic-default', {
        KYBERION_ANTHROPIC_MODEL: ' claude-fable-5 ',
      })
    ).toBe('claude-fable-5');
    expect(
      resolveRuntimeModelId('gemini-default', {
        KYBERION_GEMINI_MODEL: 'gemini-custom',
      })
    ).toBe('gemini-custom');
  });

  it('derives task-level tier and effort hints deterministically', () => {
    const registry = loadModelRegistry();

    expect(
      resolveTaskModelHint(
        {
          phase_kind: 'mechanical',
          estimated_scope: 'S',
          risk: 'low',
        },
        { registry }
      )
    ).toEqual(
      expect.objectContaining({
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.4-mini',
      })
    );

    expect(
      resolveTaskModelHint(
        {
          phase_kind: 'implement',
          estimated_scope: 'M',
        },
        { registry }
      )
    ).toEqual(
      expect.objectContaining({
        tier: 'standard',
        effort: 'medium',
        model_id: 'openai:gpt-5.5',
      })
    );

    expect(
      resolveTaskModelHint(
        {
          phase_kind: 'review',
          estimated_scope: 'M',
          risk: 'approval_required',
        },
        { registry }
      )
    ).toEqual(
      expect.objectContaining({
        tier: 'large',
        effort: 'high',
        model_id: 'openai:gpt-5.5',
      })
    );
  });

  it('falls back to the next eligible model when the small lane is unavailable', () => {
    const registry = {
      version: '1.0.0',
      default_model_id: 'openai:gpt-5.5',
      models: [
        {
          model_id: 'openai:gpt-5.5',
          provider: 'openai',
          family: 'gpt-5',
          status: 'approved' as const,
          role_fit: {
            intent_compiler: 'primary' as const,
            surface_agent: 'primary' as const,
            analysis: 'primary' as const,
            coding: 'primary' as const,
          },
          cost_band: 'high' as const,
          latency_band: 'medium' as const,
          structured_output_confidence: 'high' as const,
          tool_use_confidence: 'high' as const,
          multilingual_confidence: 'high' as const,
          reasoning_confidence: 'high' as const,
          capability_tags: [],
        },
      ],
    };

    expect(
      resolveTaskModelHint(
        {
          phase_kind: 'mechanical',
          estimated_scope: 'XS',
          risk: 'low',
        },
        { registry }
      )
    ).toEqual(
      expect.objectContaining({
        tier: 'small',
        effort: 'low',
        model_id: 'openai:gpt-5.5',
      })
    );
  });
});
