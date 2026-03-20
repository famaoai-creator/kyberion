import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeSurfaceHealth } from '@agent/core/surface-runtime';

describe('Runtime surface health probe', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns healthy for an HTTP 200 surface endpoint', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('ok', {
        status: 200,
      }),
    ) as typeof fetch;

    const result = await probeSurfaceHealth({
      id: 'chronos-mirror-v2',
      kind: 'ui',
      description: 'test',
      command: 'node',
      port: 3217,
      healthPath: '/',
    });

    expect(result.status).toBe('healthy');
  });

  it('returns unknown when no health endpoint is declared', async () => {
    const result = await probeSurfaceHealth({
      id: 'slack-bridge',
      kind: 'gateway',
      description: 'test',
      command: 'node',
    });

    expect(result.status).toBe('unknown');
  });
});
