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
});
