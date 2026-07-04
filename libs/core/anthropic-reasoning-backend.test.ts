import { describe, expect, it, vi } from 'vitest';
import { AnthropicReasoningBackend } from './anthropic-reasoning-backend.js';

describe('AnthropicReasoningBackend', () => {
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
});
