import { describe, it, expect } from 'vitest';
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
    await expect(
      handleAction({ op: 'web_search', params: { query: 'kyberion' } })
    ).resolves.toMatchObject({
      provider: 'unconfigured',
      query: 'kyberion',
      hint: 'configure service binding',
    });
  });

  it('echoes an explicitly configured provider', async () => {
    await expect(
      handleAction({
        op: 'web_search',
        params: { query: 'kyberion', provider: 'example-provider' },
      })
    ).resolves.toMatchObject({ provider: 'example-provider', query: 'kyberion' });
  });
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
