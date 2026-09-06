import { afterEach, describe, expect, it, vi } from 'vitest';
import type { A2UIMessage } from './a2ui.js';

describe('a2ui message validation', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('accepts one structurally valid operation', async () => {
    const { validateA2UIMessage } = await import('./a2ui.js');
    expect(
      validateA2UIMessage({
        updateDataModel: { surfaceId: 'surface-1', data: { status: 'ready' } },
      })
    ).toEqual({
      updateDataModel: { surfaceId: 'surface-1', data: { status: 'ready' } },
    });
  });

  it('rejects malformed operations before a surface applies them', async () => {
    const { validateA2UIMessage } = await import('./a2ui.js');
    expect(() =>
      validateA2UIMessage({
        updateDataModel: { surfaceId: 'surface-1', data: [] },
      })
    ).toThrow('A2UI data model must be an object.');
    expect(() => validateA2UIMessage({ deleteSurface: { surfaceId: 'bad id' } })).toThrow(
      'A2UI surfaceId is invalid.'
    );
  });

  it('rejects unknown wire fields and malformed component children', async () => {
    const { validateA2UIMessage } = await import('./a2ui.js');
    expect(() =>
      validateA2UIMessage({
        updateDataModel: { surfaceId: 'surface-1', data: {} },
        unexpectedOperation: {},
      })
    ).toThrow('A2UI message contains unknown field: unexpectedOperation.');
    expect(() =>
      validateA2UIMessage({
        updateComponents: {
          surfaceId: 'surface-1',
          components: [{ id: 'button-1', type: 'button', props: {}, children: [1] }],
        },
      })
    ).toThrow('A2UI component children must be an array of strings.');
    expect(() =>
      validateA2UIMessage({
        deleteSurface: { surfaceId: 'surface-1', unexpectedField: true },
      })
    ).toThrow('A2UI deleteSurface payload contains unknown field: unexpectedField.');
  });
});

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
    delete process.env.KYBERION_LOCALADMIN_TOKEN;

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

  it('forwards the localadmin bearer token for guarded remote dispatch', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    process.env.KYBERION_A2UI_BRIDGE_URL = 'https://surface.example.test';
    process.env.KYBERION_LOCALADMIN_TOKEN = 'surface-admin-token';

    const { dispatchA2UI } = await import('./a2ui.js');
    dispatchA2UI({ updateDataModel: { surfaceId: 'surface-1', data: { state: 'ready' } } });
    await Promise.resolve();

    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer surface-admin-token'
    );
  });

  it('rejects malformed messages before any transport is called', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    process.env.KYBERION_A2UI_BRIDGE_URL = 'http://127.0.0.1:3031';

    const { dispatchA2UI } = await import('./a2ui.js');
    expect(() =>
      dispatchA2UI({
        updateDataModel: { surfaceId: 'surface-1', data: {} },
        unexpectedOperation: {},
      } as unknown as A2UIMessage)
    ).toThrow('A2UI message contains unknown field: unexpectedOperation.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
