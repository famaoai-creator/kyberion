import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicReasoningBackend } from './anthropic-reasoning-backend.js';

describe('AnthropicReasoningBackend', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('maps effort hints to extended-thinking budgets', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
    });
    const parse = vi.fn();
    const backend = new AnthropicReasoningBackend({
      client: {
        messages: {
          create,
          parse,
        },
      } as any,
    });

    const out = await backend.delegateTask('do it', 'ctx', { effort: 'high' });
    expect(out).toBe('done');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        thinking: { type: 'enabled', budget_tokens: 4096 },
      })
    );
  });

  it('shrinks max_tokens when the estimated input nears the context window', async () => {
    vi.stubEnv('KYBERION_CONTEXT_WINDOW_TOKENS', '20000');
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });
    const backend = new AnthropicReasoningBackend({
      client: { messages: { create, parse: vi.fn() } } as any,
    });

    await backend.delegateTask('x'.repeat(45_000));

    const params = create.mock.calls[0][0];
    expect(params.max_tokens).toBeLessThanOrEqual(20_000 - 15_000 - 1_024);
    expect(params.max_tokens).toBeGreaterThanOrEqual(1_024);
  });

  it('keeps the configured max_tokens when the window has headroom', async () => {
    vi.stubEnv('KYBERION_CONTEXT_WINDOW_TOKENS', '200000');
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });
    const backend = new AnthropicReasoningBackend({
      client: { messages: { create, parse: vi.fn() } } as any,
    });

    await backend.delegateTask('short task');

    expect(create.mock.calls[0][0].max_tokens).toBe(16_000);
  });
});
