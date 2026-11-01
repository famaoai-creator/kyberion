import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RUSTXNG_BASE_URL,
  _resetRustxngSidecarLatchForTests,
  ensureRustxngReachable,
  resolveRustxngBaseUrl,
  rustxngWebSearch,
} from './rustxng-client.js';

describe('rustxng-client', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetRustxngSidecarLatchForTests();
  });

  it('defaults the base URL to 127.0.0.1:8888', () => {
    vi.stubEnv('KYBERION_RUSTXNG_URL', '');
    expect(resolveRustxngBaseUrl()).toBe(DEFAULT_RUSTXNG_BASE_URL);
  });

  it('prefers KYBERION_RUSTXNG_URL over the default', () => {
    vi.stubEnv('KYBERION_RUSTXNG_URL', 'http://127.0.0.1:9999/');
    expect(resolveRustxngBaseUrl()).toBe('http://127.0.0.1:9999');
  });

  it('calls /healthz then /search with grounding params when already up', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/healthz')) {
        return new Response('OK', { status: 200 });
      }
      expect(url).toContain('/search?');
      expect(url).toContain('q=tokio');
      expect(url).toContain('format=json');
      expect(url).toContain('include_raw_content=1');
      expect(url).toContain('max_results=2');
      return Response.json({
        query: 'tokio',
        results: [
          {
            title: 'Tokio',
            url: 'https://tokio.rs/',
            content: 'async runtime',
            raw_content: 'full page text',
            engine: 'duckduckgo',
            score: 1.5,
          },
          { title: 'skip-me', url: '', content: 'no url' },
        ],
        unresponsive_engines: [['google', 'Suspended: Access denied']],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await rustxngWebSearch({ query: 'tokio', top_k: 2 });
    expect(result.provider).toBe('rustxng');
    expect(result.sidecar_started).toBeUndefined();
    expect(result.results).toEqual([
      {
        title: 'Tokio',
        url: 'https://tokio.rs/',
        content: 'async runtime',
        raw_content: 'full page text',
        engine: 'duckduckgo',
        score: 1.5,
      },
    ]);
    expect(result.unresponsive_engines).toEqual([['google', 'Suspended: Access denied']]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('auto-starts a loopback sidecar when /healthz is down', async () => {
    let healthy = false;
    const spawn = vi.fn(() => {
      healthy = true;
      return { unref: vi.fn() } as unknown as ReturnType<
        typeof import('@agent/core/secure-io').safeSpawn
      >;
    });
    const started = await ensureRustxngReachable('http://127.0.0.1:8888', {
      probeHealth: async () => healthy,
      spawn,
      resolveBin: () => '/opt/kyberion/bin/rustxng',
      existsSync: () => true,
      sleep: async () => undefined,
      now: (() => {
        let t = 0;
        return () => {
          t += 200;
          return t;
        };
      })(),
    });
    expect(started).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      '/opt/kyberion/bin/rustxng',
      ['--bind', '127.0.0.1', '--port', '8888'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        env: expect.objectContaining({ RUSTXNG_IDLE_TIMEOUT: '300' }),
      })
    );
  });

  it('refuses auto-start for non-loopback URLs', async () => {
    await expect(
      ensureRustxngReachable('http://search.example.com:8888', {
        probeHealth: async () => false,
      })
    ).rejects.toThrow(/auto-start only supports loopback/);
  });

  it('respects KYBERION_RUSTXNG_AUTOSTART=0', async () => {
    vi.stubEnv('KYBERION_RUSTXNG_AUTOSTART', '0');
    await expect(
      ensureRustxngReachable('http://127.0.0.1:8888', {
        probeHealth: async () => false,
      })
    ).rejects.toThrow(/AUTOSTART is disabled/);
  });

  it('coalesces concurrent sidecar starts into one spawn', async () => {
    let healthy = false;
    const spawn = vi.fn(() => {
      healthy = true;
      return { unref: vi.fn() } as unknown as ReturnType<
        typeof import('@agent/core/secure-io').safeSpawn
      >;
    });
    const deps = {
      probeHealth: async () => healthy,
      spawn,
      resolveBin: () => '/opt/kyberion/bin/rustxng',
      existsSync: () => true,
      sleep: async () => undefined,
      now: (() => {
        let t = 0;
        return () => {
          t += 50;
          return t;
        };
      })(),
    };
    const [a, b] = await Promise.all([
      ensureRustxngReachable('http://127.0.0.1:8888', deps),
      ensureRustxngReachable('http://127.0.0.1:8888', deps),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
