import { describe, expect, it } from 'vitest';
import { resolveAgentLifecycleModelId } from './agent-lifecycle.js';

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
});
