import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicReasoningBackend } from './anthropic-reasoning-backend.js';
import { applyCacheBreakpointToSystemBlocks } from './prompt-cache-discipline.js';
import { resolveRuntimeModelId } from './runtime-model-defaults.js';

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

  it('places the KD-08 cache breakpoints on tools and the last message for generateWithTools', async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const backend = new AnthropicReasoningBackend({
      client: { messages: { create, parse: vi.fn() } } as any,
    });

    await backend.generateWithTools('do the thing', [
      { name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object' } },
    ]);

    const params = create.mock.calls[0][0];
    expect(params.tools).toHaveLength(1);
    expect(params.tools[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(params.messages[0].content).toEqual([
      { type: 'text', text: 'do the thing', cache_control: { type: 'ephemeral' } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// KD-08 acceptance criterion 2 (opt-in, hits the real Anthropic API): cache_read
// tokens must accrue from the second call onward when the same stable prefix
// (system + tools, unchanged bytes) is resent. Gated on ANTHROPIC_API_KEY like
// other real-backend suites in this repo (see libs/core/visual-raster.test.ts
// for the same describe.skipIf convention against a different capability).
// ---------------------------------------------------------------------------
describe.skipIf(!process.env.ANTHROPIC_API_KEY)(
  'AnthropicReasoningBackend prompt-cache discipline (opt-in, requires ANTHROPIC_API_KEY)',
  () => {
    it('reports cache_read_input_tokens on the second call reusing the identical stable prefix', async () => {
      const client = new Anthropic();
      const model = resolveRuntimeModelId('anthropic-fast');
      // Padded well past every model's minimum cacheable prefix length so the
      // breakpoint actually creates/reuses a cache entry.
      const stableSystem = applyCacheBreakpointToSystemBlocks([
        {
          type: 'text' as const,
          text:
            'You are a hermetic-opt-in fixture for KD-08 prompt-cache discipline. ' +
            'Context filler for cache padding. '.repeat(700),
        },
      ]);

      const first = await client.messages.create({
        model,
        max_tokens: 8,
        system: stableSystem,
        messages: [{ role: 'user', content: 'Reply with exactly one word: first.' }],
      });
      expect(first.usage.cache_creation_input_tokens ?? 0).toBeGreaterThan(0);

      const second = await client.messages.create({
        model,
        max_tokens: 8,
        system: stableSystem,
        messages: [{ role: 'user', content: 'Reply with exactly one word: second.' }],
      });
      expect(second.usage.cache_read_input_tokens ?? 0).toBeGreaterThan(0);
    }, 30_000);
  }
);
