import { afterEach, describe, expect, it, vi } from 'vitest';

describe('a2ui dispatch', () => {
  const originalFetch = globalThis.fetch;
  const originalBridgeUrl = process.env.KYBERION_A2UI_BRIDGE_URL;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.KYBERION_A2UI_BRIDGE_URL = originalBridgeUrl;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('redacts sensitive payload fields before relaying', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    process.env.KYBERION_A2UI_BRIDGE_URL = 'http://127.0.0.1:3031';

    const { dispatchA2UI } = await import('./a2ui.js');

    dispatchA2UI({
      updateDataModel: {
        surfaceId: 'surface-1',
        data: {
          token: 'top-secret-token',
          nested: { apiKey: 'sk-test-1234567890abcdef' },
        },
      },
    });

    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(String(init?.body)).toContain('[REDACTED_SECRET]');
    expect(String(init?.body)).not.toContain('top-secret-token');
    expect(String(init?.body)).not.toContain('sk-test-1234567890abcdef');
  });
});
