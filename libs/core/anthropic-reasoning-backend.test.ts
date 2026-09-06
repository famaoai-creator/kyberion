import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  AnthropicReasoningBackend,
  deriveAnthropicCacheStats,
} from './anthropic-reasoning-backend.js';
import { applyCacheBreakpointToSystemBlocks } from './prompt-cache-discipline.js';
import { resolveRuntimeModelId } from './runtime-model-defaults.js';
import { metrics } from './metrics.js';

describe('AnthropicReasoningBackend', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('routes SDK usage mission attribution through the governed environment accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/anthropic-reasoning-backend.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('process.env.MISSION_ID');
    expect(source).toContain("getRegisteredEnvText('MISSION_ID')");
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

  it('forwards delegation cancellation to the Anthropic SDK request options', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
    });
    const backend = new AnthropicReasoningBackend({
      client: { messages: { create, parse: vi.fn() } } as any,
    });
    const controller = new AbortController();

    await backend.delegateTask('do it', undefined, { signal: controller.signal });

    expect(create).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal });
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

  it('derives request-level cache hit/miss evidence from provider usage', () => {
    expect(deriveAnthropicCacheStats({ cache_creation_input_tokens: 100 })).toEqual({
      hits: 0,
      misses: 1,
    });
    expect(deriveAnthropicCacheStats({ cache_read_input_tokens: 100 })).toEqual({
      hits: 1,
      misses: 0,
    });
    expect(
      deriveAnthropicCacheStats({ cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
    ).toBeUndefined();
  });

  it('records provider cache-hit evidence for tool-capable calls', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 8 },
    });
    const record = vi.spyOn(metrics, 'record').mockImplementation(() => undefined);
    const backend = new AnthropicReasoningBackend({
      client: { messages: { create, parse: vi.fn() } } as any,
    });

    await backend.generateWithTools('use the cached tools', [
      { name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object' } },
    ]);

    expect(record).toHaveBeenCalledWith(
      'anthropic-sdk',
      expect.any(Number),
      'success',
      expect.objectContaining({ cacheStats: { hits: 1, misses: 0 } })
    );
  });
});

it('emits Anthropic native deferred-tool definitions and returns tool references', async () => {
  const create = vi.fn().mockResolvedValue({
    content: [
      {
        type: 'tool_search_tool_result',
        tool_use_id: 'search-1',
        content: {
          type: 'tool_search_tool_search_result',
          tool_references: [{ type: 'tool_reference', tool_name: 'deploy_service' }],
        },
      },
      { type: 'text', text: 'tool discovered' },
    ],
  });
  const backend = new AnthropicReasoningBackend({
    enableNativeDeferredTools: true,
    client: { messages: { create, parse: vi.fn() } } as any,
  });

  const result = await backend.generateWithTools(
    'find the deployment tool',
    [{ name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object' } }],
    {
      deferred_tool_definitions: [
        {
          name: 'deploy_service',
          description: 'Deploy a governed service.',
          inputSchema: { type: 'object', properties: { service: { type: 'string' } } },
        },
      ],
    }
  );

  const params = create.mock.calls[0][0];
  expect(params.tools).toHaveLength(3);
  expect(params.tools[1]).toMatchObject({ name: 'deploy_service', defer_loading: true });
  expect(params.tools[2]).toMatchObject({
    type: 'tool_search_tool_bm25_20251119',
    name: 'tool_search_tool_bm25',
  });
  expect(result).toMatchObject({
    text: 'tool discovered',
    deferredToolReferences: ['deploy_service'],
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
