import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  GROK_API_DEFAULT_BASE_URL,
  GROK_API_DEFAULT_MODEL,
  buildGrokApiBackendFromEnv,
  probeGrokApiBackendAvailability,
  resolveGrokApiKey,
  resolveGrokApiModel,
} from './grok-api-backend.js';

describe('grok-api-backend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.XAI_API_KEY;
    delete process.env.KYBERION_GROK_API_KEY;
    delete process.env.KYBERION_GROK_API_URL;
    delete process.env.KYBERION_GROK_API_MODEL;
    delete process.env.KYBERION_REASONING_MODEL;
  });

  it('routes Grok API environment reads through the governed accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/grok-api-backend.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });

  it('does not build without an xAI API key', () => {
    expect(buildGrokApiBackendFromEnv({})).toBeNull();
    expect(resolveGrokApiKey({})).toBeUndefined();
  });

  it('builds from XAI_API_KEY with the official host and grok-4.6 default', () => {
    const backend = buildGrokApiBackendFromEnv({ XAI_API_KEY: 'xai-test-key' });
    expect(backend?.name).toBe('openai-compatible');
    expect(backend?.egressEndpoint).toBe(`${GROK_API_DEFAULT_BASE_URL}/`);
    expect(resolveGrokApiModel({})).toBe(GROK_API_DEFAULT_MODEL);
  });

  it('accepts KYBERION_GROK_API_KEY and model override', () => {
    const backend = buildGrokApiBackendFromEnv(
      { KYBERION_GROK_API_KEY: 'kyb-xai-key', KYBERION_GROK_API_MODEL: 'grok-4.5' },
      { model: 'grok-4.6' }
    );
    expect(backend).not.toBeNull();
    expect(resolveGrokApiKey({ KYBERION_GROK_API_KEY: 'kyb-xai-key' })).toBe('kyb-xai-key');
  });

  it('reports missing credentials without calling the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const probe = await probeGrokApiBackendAvailability({});
    expect(probe.available).toBe(false);
    expect(probe.reason).toMatch(/XAI_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('probes the models endpoint when a key is present', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ id: 'grok-4.6' }] }), { status: 200 })
        )
    );
    const probe = await probeGrokApiBackendAvailability({ XAI_API_KEY: 'xai-test-key' });
    expect(probe.available).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.x.ai/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { authorization: 'Bearer xai-test-key' },
      })
    );
  });

  it('inlines validated image attachments using the OpenAI vision message shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'A Kyberion mark.' } }],
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const backend = buildGrokApiBackendFromEnv({ XAI_API_KEY: 'xai-test-key' });

    await expect(
      backend?.promptWithImages?.('What is shown?', [
        { path: 'docs/assets/kyberion-social-preview.png', media_type: 'image/png' },
      ])
    ).resolves.toBe('A Kyberion mark.');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      messages: Array<{
        role: string;
        content: Array<{ type: string; image_url?: { url: string } }>;
      }>;
    };
    const userContent = body.messages[1].content;
    expect(userContent[0].type).toBe('image_url');
    expect(userContent[0].image_url?.url).toMatch(/^data:image\/png;base64,/u);
    expect(userContent[1]).toMatchObject({ type: 'text' });
  });

  it('surfaces a non-OK models probe as unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })));
    const probe = await probeGrokApiBackendAvailability({ XAI_API_KEY: 'bad-key' });
    expect(probe.available).toBe(false);
    expect(probe.reason).toMatch(/HTTP 401/);
  });

  it('rejects a successful probe when the selected model is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ id: 'grok-4.5' }] }), { status: 200 })
        )
    );
    const probe = await probeGrokApiBackendAvailability({
      XAI_API_KEY: 'xai-test-key',
      KYBERION_GROK_API_MODEL: 'grok-4.6',
    });
    expect(probe.available).toBe(false);
    expect(probe.reason).toMatch(/grok-4\.6/);
  });

  it('rejects a primitive or array models response before projecting model ids', async () => {
    for (const payload of [null, [], 'models']) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
      const probe = await probeGrokApiBackendAvailability({ XAI_API_KEY: 'xai-test-key' });
      expect(probe.available).toBe(false);
      expect(probe.reason).toContain('malformed');
    }
  });

  it('rejects dangerous and malformed model entries fail-closed', async () => {
    for (const payload of [
      { data: [{ id: 'grok-4.6', constructor: {} }] },
      { data: [{ id: 42 }] },
      { data: ['grok-4.6'] },
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
      const probe = await probeGrokApiBackendAvailability({ XAI_API_KEY: 'xai-test-key' });
      expect(probe.available).toBe(false);
      expect(probe.reason).toContain('malformed');
    }
  });
});
