import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  OPENROUTER_FREE_ROUTER_MODEL,
  resolveOpenRouterModelPolicy,
  validateOpenRouterModelRecord,
} from './openrouter-model-policy.js';

describe('openrouter-model-policy', () => {
  it('defaults to the free router and free-only cost policy', () => {
    expect(resolveOpenRouterModelPolicy({})).toEqual({
      profile: 'free-router',
      model: OPENROUTER_FREE_ROUTER_MODEL,
      costPolicy: 'free-only',
      requiredParameters: ['tools', 'tool_choice'],
    });
  });

  it('allows an explicitly pinned free model', () => {
    expect(
      resolveOpenRouterModelPolicy({
        KYBERION_OPENROUTER_MODEL: 'qwen/qwen3-coder:free',
      })
    ).toMatchObject({ profile: 'free-pinned', model: 'qwen/qwen3-coder:free' });
  });

  it('requires an explicit paid opt-in for a paid model', () => {
    expect(() =>
      resolveOpenRouterModelPolicy({ KYBERION_OPENROUTER_MODEL: 'openai/gpt-4o' })
    ).toThrow('paid inference');

    expect(
      resolveOpenRouterModelPolicy({
        KYBERION_OPENROUTER_MODEL: 'openai/gpt-4o',
        KYBERION_OPENROUTER_COST_POLICY: 'paid-allowed',
      })
    ).toMatchObject({ profile: 'explicit', costPolicy: 'paid-allowed' });
  });

  it('validates pricing and required OpenRouter parameters', () => {
    const policy = resolveOpenRouterModelPolicy({
      KYBERION_OPENROUTER_MODEL: 'qwen/qwen3-coder:free',
    });

    expect(
      validateOpenRouterModelRecord(
        {
          id: 'qwen/qwen3-coder:free',
          pricing: { prompt: '0', completion: '0', request: '0' },
          supported_parameters: ['tools', 'tool_choice'],
        },
        policy
      )
    ).toEqual([]);

    expect(
      validateOpenRouterModelRecord(
        {
          id: 'qwen/qwen3-coder:free',
          pricing: { prompt: '0', completion: '0' },
          supported_parameters: ['tools'],
        },
        policy
      )
    ).toEqual(['model does not support required parameter "tool_choice"']);
  });

  it('routes OpenRouter runtime environment reads through the governed accessor', () => {
    for (const file of [
      'libs/core/openrouter-model-policy.ts',
      'libs/core/openrouter-backend.ts',
    ]) {
      const source = String(
        safeReadFile(pathResolver.rootResolve(file), {
          encoding: 'utf8',
        })
      );
      expect(source).not.toMatch(/env\.KYBERION_/u);
      expect(source).toContain('getRegisteredEnvText');
    }
  });
});
