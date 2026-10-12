import { afterEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { buildFailoverReasoningBackend, stubReasoningBackend } from './reasoning-backend.js';
import {
  withoutAutomaticReasoningRedispatch,
  automaticReasoningRedispatchAllowed,
} from './reasoning-dispatch-scope.js';
import { AnthropicReasoningBackend } from '../provider/anthropic-reasoning-backend.js';
import { clearProviderHealth } from '../provider/provider-health-registry.js';

afterEach(() => {
  clearProviderHealth();
  vi.restoreAllMocks();
});
describe('lexical no-redispatch scope', () => {
  it('stops both candidate retries and failover after an ambiguous tool/delegation error, preserving legacy behavior outside scope', async () => {
    const first = vi.fn(async () => {
      throw new Error('503 service unavailable');
    });
    const second = vi.fn(async () => 'served');
    const chain = buildFailoverReasoningBackend(
      [
        {
          backend: {
            ...stubReasoningBackend,
            delegateTask: first,
            generateWithTools: async () => {
              await first();
              return {};
            },
          },
        },
        {
          backend: {
            ...stubReasoningBackend,
            delegateTask: second,
            generateWithTools: async () => ({ text: await second() }),
          },
        },
      ],
      { max_in_place_retries: 2 }
    );
    await expect(
      withoutAutomaticReasoningRedispatch(() => chain.delegateTask('synthetic'))
    ).rejects.toThrow('503');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    await expect(
      withoutAutomaticReasoningRedispatch(() => chain.generateWithTools!('synthetic', []))
    ).rejects.toThrow('503');
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).not.toHaveBeenCalled();
    expect(automaticReasoningRedispatchAllowed()).toBe(true);
    expect(await chain.delegateTask('synthetic')).toBe('served');
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('holds an empty dispatched stream without trying another route or prompt', async () => {
    const first = vi.fn(async function* () {});
    const second = vi.fn(async function* () {
      yield 'second';
    });
    const prompt = vi.fn(async () => 'fallback');
    const chain = buildFailoverReasoningBackend([
      { backend: { ...stubReasoningBackend, streamPrompt: first, prompt } },
      { backend: { ...stubReasoningBackend, streamPrompt: second, prompt } },
    ]);
    await expect(
      withoutAutomaticReasoningRedispatch(async () => {
        for await (const _delta of chain.streamPrompt!('synthetic')) {
          // Drain the synthetic stream until its guarded failure.
        }
      })
    ).rejects.toThrow('ended empty');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('disables SDK request retries only inside scope and preserves unrelated concurrent calls', async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'synthetic' }] });
    const parse = vi.fn().mockResolvedValue({ parsed_output: { hypotheses: [] } });
    const backend = new AnthropicReasoningBackend({
      client: { messages: { create, parse } } as unknown as Anthropic,
    });
    await withoutAutomaticReasoningRedispatch(() => backend.delegateTask('one'));
    expect(create.mock.calls[0][1]).toMatchObject({ maxRetries: 0 });
    await backend.delegateTask('two');
    expect(create.mock.calls[1][1]).toBeUndefined();
    await withoutAutomaticReasoningRedispatch(() =>
      backend.crossCritique({ topic: 'synthetic', personas: [], hypotheses: [] })
    );
    expect(parse.mock.calls[0][1]).toMatchObject({ maxRetries: 0 });
    await backend.crossCritique({ topic: 'synthetic', personas: [], hypotheses: [] });
    expect(parse.mock.calls[1][1]).toBeUndefined();
    const [guarded, normal] = await Promise.all([
      withoutAutomaticReasoningRedispatch(async () => {
        await Promise.resolve();
        return automaticReasoningRedispatchAllowed();
      }),
      Promise.resolve().then(() => automaticReasoningRedispatchAllowed()),
    ]);
    expect([guarded, normal]).toEqual([false, true]);
  });
});
