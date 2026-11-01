import { afterEach, describe, expect, it, vi } from 'vitest';
import { actuator, handleAction } from './index.js';
import { describeOps } from './op-catalog.js';

describe('search-actuator: op catalog', () => {
  it('exposes exactly web_search and fetch_reader as capture ops', () => {
    const ops = describeOps();
    expect(ops.map((op) => op.op).sort()).toEqual(['fetch_reader', 'web_search']);
    for (const op of ops) {
      expect(op.kind).toBe('capture');
      expect(op.input_schema).toBeDefined();
      expect(op.examples?.length).toBeGreaterThan(0);
    }
  });

  it('requires query for web_search input schema', () => {
    const spec = describeOps().find((op) => op.op === 'web_search');
    expect(spec?.input_schema).toMatchObject({ required: ['query'] });
  });
});

describe('search-actuator: web_search', () => {
  it('rejects missing query', async () => {
    await expect(handleAction({ op: 'web_search', params: {} })).rejects.toThrow(
      /missing required fields.*params\.query/i
    );
  });

  it('rejects blank query', async () => {
    await expect(handleAction({ op: 'web_search', params: { query: '   ' } })).rejects.toThrow(
      /missing required fields.*params\.query/i
    );
  });

  it('returns offline stub by default', async () => {
    const result = await handleAction({ op: 'web_search', params: { query: 'kyberion' } });
    expect(result).toMatchObject({
      provider: 'unconfigured',
      query: 'kyberion',
      results: [],
    });
    expect(String((result as { hint?: string }).hint)).toMatch(/configure service binding/i);
  });

  it('rejects an unregistered search provider', async () => {
    await expect(
      handleAction({
        op: 'web_search',
        params: { query: 'kyberion', provider: 'example-provider' },
      })
    ).rejects.toThrow(/web-search-runtime.*not registered/i);
  });

  it('routes provider=rustxng through the web-search-runtime seam', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/healthz')) return new Response('OK', { status: 200 });
      return Response.json({
        query: 'kyberion',
        results: [{ title: 'Kyberion', url: 'https://example.com/kyberion', content: 'ops' }],
        unresponsive_engines: [],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(
        handleAction({
          op: 'web_search',
          params: { query: 'kyberion', provider: 'rustxng', top_k: 1 },
        })
      ).resolves.toMatchObject({
        provider: 'rustxng',
        query: 'kyberion',
        results: [{ title: 'Kyberion', url: 'https://example.com/kyberion' }],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('search-actuator: fetch_reader', () => {
  it('rejects non-http URLs', async () => {
    await expect(
      handleAction({ op: 'fetch_reader', params: { url: 'ftp://example.com/file' } })
    ).rejects.toThrow(/absolute http\(s\) URL/i);
  });

  it('rejects non-URL strings', async () => {
    await expect(
      handleAction({ op: 'fetch_reader', params: { url: 'not a url' } })
    ).rejects.toThrow(/absolute http\(s\) URL/i);
  });

  it('rejects missing url', async () => {
    await expect(handleAction({ op: 'fetch_reader', params: {} })).rejects.toThrow(
      /missing required fields.*params\.url/i
    );
  });

  it('reaches the search handler via SDK dispatch', async () => {
    const result = await actuator.dispatch('web_search', { query: 'sdk probe' });
    expect(result.ok).toBe(true);
    expect(result.value ?? (result as { output?: unknown }).output).toMatchObject({
      provider: 'unconfigured',
      query: 'sdk probe',
    });
  });
});
