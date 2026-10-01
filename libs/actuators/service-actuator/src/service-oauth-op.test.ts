import { beforeEach, describe, expect, it, vi } from 'vitest';

const oauth = vi.hoisted(() => ({
  beginServiceOAuth: vi.fn(),
  exchangeServiceOAuthCode: vi.fn(),
  refreshServiceOAuthToken: vi.fn(),
}));

vi.mock('@agent/core/oauth-broker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/oauth-broker')>()),
  ...oauth,
}));

import { actuator } from './index.js';

describe('service-actuator oauth op (SDK dispatch / ADF path)', () => {
  beforeEach(() => {
    for (const fn of Object.values(oauth)) fn.mockReset();
  });

  it('routes begin / exchange / refresh to the OAuth broker', async () => {
    oauth.beginServiceOAuth.mockReturnValue({
      authorization_url: 'https://auth.example/authorize',
    });
    oauth.exchangeServiceOAuthCode.mockResolvedValue({ stored: true });
    oauth.refreshServiceOAuthToken.mockResolvedValue({ refreshed: true });

    const begin = await actuator.dispatch('oauth', {
      service_id: 'github',
      action: 'begin',
      params: { redirect_uri: 'http://127.0.0.1:8787/callback' },
    });
    expect(begin.ok).toBe(true);
    expect(oauth.beginServiceOAuth).toHaveBeenCalledWith('github', {
      redirect_uri: 'http://127.0.0.1:8787/callback',
    });

    await expect(
      actuator.dispatch('oauth', {
        service_id: 'github',
        action: 'exchange',
        params: { code: 'c' },
      })
    ).resolves.toMatchObject({ ok: true });
    expect(oauth.exchangeServiceOAuthCode).toHaveBeenCalledWith('github', { code: 'c' });

    await expect(
      actuator.dispatch('oauth', { service_id: 'github', action: 'refresh' })
    ).resolves.toMatchObject({ ok: true });
    expect(oauth.refreshServiceOAuthToken).toHaveBeenCalledWith('github', {});
  });

  it('rejects an unknown OAuth action', async () => {
    const result = await actuator.dispatch('oauth', { service_id: 'github', action: 'revoke' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unsupported OAuth action: revoke');
  });
});
