import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  axios: vi.fn(),
}));

vi.mock('axios', () => ({
  default: mocks.axios,
}));

describe('secureFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('treats query-authenticated requests as authenticated for domain allowlisting', async () => {
    const { secureFetch } = await import('./network.js');

    await expect(
      secureFetch({
        url: 'https://notgithub.com/api',
        params: { apiKey: 'secret-token' },
        authenticateRequest: true,
      }),
    ).rejects.toThrow('Authenticated request to non-whitelisted domain');

    expect(mocks.axios).not.toHaveBeenCalled();
  });

  it('redacts sensitive payload fields and headers before dispatching', async () => {
    mocks.axios.mockResolvedValue({ data: { ok: true } });
    const { secureFetch } = await import('./network.js');

    await secureFetch({
      url: 'https://api.github.com/test',
      data: {
        user: 'alice',
        credentials: {
          apiKey: 'sk-test-1234567890abcdef',
          nested: ['keep', 'also-keep'],
        },
      },
      params: {
        token: 'top-secret-token',
        path: '/Users/alice/project/secrets.txt',
      },
      headers: {
        Authorization: 'Bearer top-secret-token',
        'X-Trace': 'safe-value',
      },
    });

    expect(mocks.axios).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        user: 'alice',
        credentials: {
          apiKey: '[REDACTED_SECRET]',
          nested: ['keep', 'also-keep'],
        },
      },
      params: {
        token: '[REDACTED_SECRET]',
        path: '[REDACTED_PATH]/project/secrets.txt',
      },
      headers: {
        Authorization: '[REDACTED_SECRET]',
        'X-Trace': 'safe-value',
      },
    }));
  });
});
