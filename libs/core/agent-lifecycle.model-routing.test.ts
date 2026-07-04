import { describe, expect, it } from 'vitest';
import { resolveAgentLifecycleModelId } from './agent-lifecycle.js';
import { resolveAgentTrustScore } from './agent-registry.js';
import { trustEngine } from './trust-engine.js';

describe('agent-lifecycle model routing', () => {
  it('keeps the manifest model in advisory mode', () => {
    expect(
      resolveAgentLifecycleModelId(
        {
          modelId: 'openai:gpt-5.4-mini',
          runtimeMetadata: {
            task_model_hint: {
              tier: 'large',
              effort: 'high',
              model_id: 'openai:gpt-5.5',
              route_reason: 'test',
            },
          },
        },
        {
          KYBERION_TASK_MODEL_ROUTING: 'advisory',
        }
      )
    ).toBe('openai:gpt-5.4-mini');
  });

  it('prefers the task hint when routing is enforced', () => {
    expect(
      resolveAgentLifecycleModelId(
        {
          modelId: 'openai:gpt-5.4-mini',
          runtimeMetadata: {
            task_model_hint: {
              tier: 'large',
              effort: 'high',
              model_id: 'openai:gpt-5.5',
              route_reason: 'test',
            },
          },
        },
        {
          KYBERION_TASK_MODEL_ROUTING: 'enforce',
        }
      )
    ).toBe('openai:gpt-5.5');
  });

  it('uses the trust engine score instead of a fixed bootstrap value', () => {
    const agentId = `agent-${Date.now()}-trust`;
    trustEngine.initialize(agentId, 742);

    expect(resolveAgentTrustScore(agentId)).toBe(742);
    expect(resolveAgentTrustScore(`${agentId}-missing`)).toBe(500);
  });
});
