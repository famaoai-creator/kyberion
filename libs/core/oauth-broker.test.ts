import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeReadFile: vi.fn(),
  safeWriteFile: vi.fn(),
  safeExistsSync: vi.fn(),
  safeMkdir: vi.fn(),
  safeReaddir: vi.fn(),
  safeUnlinkSync: vi.fn(),
  safeFsyncFile: vi.fn(),
  resolveServiceBinding: vi.fn(),
  loadServiceEndpointsCatalog: vi.fn(),
  executeServicePreset: vi.fn(),
  loadConnectionDocument: vi.fn(),
  storeConnectionDocument: vi.fn(),
}));

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual('./secure-io.js') as any;
  return {
    ...actual,
    safeReadFile: mocks.safeReadFile,
    safeWriteFile: mocks.safeWriteFile,
    safeExistsSync: mocks.safeExistsSync,
    safeMkdir: mocks.safeMkdir,
    safeReaddir: mocks.safeReaddir,
    safeUnlinkSync: mocks.safeUnlinkSync,
    safeFsyncFile: mocks.safeFsyncFile,
  };
});

vi.mock('./service-binding.js', () => ({
  resolveServiceBinding: mocks.resolveServiceBinding,
  loadServiceEndpointsCatalog: mocks.loadServiceEndpointsCatalog,
}));

vi.mock('./service-engine.js', () => ({
  executeServicePreset: mocks.executeServicePreset,
}));

vi.mock('./secret-guard.js', () => ({
  loadConnectionDocument: mocks.loadConnectionDocument,
  storeConnectionDocument: mocks.storeConnectionDocument,
}));

describe('oauth-broker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeExistsSync.mockReturnValue(false);
    mocks.safeReaddir.mockReturnValue([]);
    mocks.resolveServiceBinding.mockReturnValue({
      serviceId: 'canva',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'http://127.0.0.1:8787/oauth/callback',
    });
    mocks.storeConnectionDocument.mockReturnValue({
      path: '/Users/famao/kyberion/knowledge/personal/connections/canva.json',
      changedKeys: ['access_token', 'refresh_token'],
    });
    mocks.loadConnectionDocument.mockReturnValue({
      redirect_uri: 'http://127.0.0.1:8787/oauth/callback',
    });
    mocks.loadServiceEndpointsCatalog.mockReturnValue({
      default_pattern: 'https://api.{service_id}.com/v1',
      services: {
        canva: { preset_path: 'knowledge/public/orchestration/service-presets/canva.json' },
      },
    });
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('canva.json')) {
        return JSON.stringify({
          oauth: {
            authorize_url: 'https://www.canva.com/api/oauth/authorize',
            token_operation: 'exchange_oauth_code',
            refresh_operation: 'refresh_oauth_token',
            pkce: true,
            scopes: ['design:meta:read', 'asset:write'],
          },
        });
      }
      return '';
    });
  });

  it('builds an authorization url and stores pending pkce state', async () => {
    const { beginServiceOAuth } = await import('./oauth-broker.js');
    const result = beginServiceOAuth('canva');

    expect(result.authorizationUrl).toContain('https://www.canva.com/api/oauth/authorize?');
    expect(result.authorizationUrl).toContain('client_id=client-id');
    expect(result.authorizationUrl).toContain('scope=design%3Ameta%3Aread+asset%3Awrite');
    expect(result.authorizationUrl).toContain('code_challenge=');
    expect(result.codeVerifier).toBeTruthy();
    expect(mocks.safeWriteFile).toHaveBeenCalledTimes(1);
  });

  it('exchanges an oauth code and persists refreshed credentials', async () => {
    mocks.safeExistsSync.mockImplementation((filePath: string) =>
      filePath.includes('/active/shared/tmp/oauth/canva') || filePath.includes('/active/shared/tmp/oauth/canva/test-state.json'),
    );
    mocks.loadServiceEndpointsCatalog.mockReturnValue({
      default_pattern: 'https://api.{service_id}.com/v1',
      services: {
        canva: { preset_path: 'knowledge/public/orchestration/service-presets/canva.json' },
      },
    });
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('service-presets/canva.json')) {
        return JSON.stringify({
          oauth: {
            authorize_url: 'https://www.canva.com/api/oauth/authorize',
            token_operation: 'exchange_oauth_code',
            refresh_operation: 'refresh_oauth_token',
            pkce: true,
          },
        });
      }
      if (filePath.includes('/active/shared/tmp/oauth/canva/test-state.json')) {
        return JSON.stringify({
          serviceId: 'canva',
          state: 'test-state',
          codeVerifier: 'pkce-verifier',
          redirectUri: 'http://127.0.0.1:8787/oauth/callback',
          scopes: ['design:meta:read'],
          createdAt: '2026-03-23T00:00:00.000Z',
        });
      }
      return '';
    });
    mocks.executeServicePreset.mockResolvedValue({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      scope: 'design:meta:read',
      token_type: 'Bearer',
    });

    const { exchangeServiceOAuthCode } = await import('./oauth-broker.js');
    const result = await exchangeServiceOAuthCode('canva', {
      code: 'auth-code',
      state: 'test-state',
    });

    expect(mocks.executeServicePreset).toHaveBeenCalledWith('canva', 'exchange_oauth_code', {
      code: 'auth-code',
      code_verifier: 'pkce-verifier',
      redirect_uri: 'http://127.0.0.1:8787/oauth/callback',
    }, 'secret-guard');
    expect(mocks.storeConnectionDocument).toHaveBeenCalledWith('canva', expect.objectContaining({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      scope: 'design:meta:read',
      redirect_uri: 'http://127.0.0.1:8787/oauth/callback',
    }), { actor: 'oauth_broker' });
    expect(result.persisted_path).toContain('connections/canva.json');
    expect(mocks.safeUnlinkSync).toHaveBeenCalledTimes(1);
  });

  it('refreshes an oauth token using stored refresh credentials', async () => {
    mocks.resolveServiceBinding.mockReturnValue({
      serviceId: 'canva',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'stored-refresh-token',
      redirectUri: 'http://127.0.0.1:8787/oauth/callback',
    });
    mocks.executeServicePreset.mockResolvedValue({
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      expires_in: 14400,
      token_type: 'Bearer',
    });

    const { refreshServiceOAuthToken } = await import('./oauth-broker.js');
    await refreshServiceOAuthToken('canva');

    expect(mocks.executeServicePreset).toHaveBeenCalledWith('canva', 'refresh_oauth_token', {
      refresh_token: 'stored-refresh-token',
    }, 'secret-guard');
    expect(mocks.storeConnectionDocument).toHaveBeenCalledWith('canva', expect.objectContaining({
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
    }), { actor: 'oauth_broker' });
  });

  it('completes a generic callback by resolving the service from state', async () => {
    mocks.safeExistsSync.mockImplementation((filePath: string) =>
      filePath.includes('/active/shared/tmp/oauth') || filePath.includes('/active/shared/tmp/oauth/canva/test-state.json'),
    );
    mocks.safeReaddir.mockImplementation((dirPath: string) => {
      if (dirPath.endsWith('/active/shared/tmp/oauth')) return ['canva'];
      if (dirPath.endsWith('/active/shared/tmp/oauth/canva')) return ['test-state.json'];
      return [];
    });
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('service-presets/canva.json')) {
        return JSON.stringify({
          oauth: {
            authorize_url: 'https://www.canva.com/api/oauth/authorize',
            token_operation: 'exchange_oauth_code',
            refresh_operation: 'refresh_oauth_token',
            pkce: true,
          },
        });
      }
      if (filePath.includes('/active/shared/tmp/oauth/canva/test-state.json')) {
        return JSON.stringify({
          serviceId: 'canva',
          state: 'test-state',
          codeVerifier: 'pkce-verifier',
          redirectUri: 'http://127.0.0.1:8787/oauth/callback',
          scopes: ['design:meta:read'],
          createdAt: '2026-03-23T00:00:00.000Z',
        });
      }
      return '';
    });
    mocks.executeServicePreset.mockResolvedValue({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      token_type: 'Bearer',
    });

    const { completeOAuthCallback } = await import('./oauth-broker.js');
    const result = await completeOAuthCallback({
      code: 'auth-code',
      state: 'test-state',
    });

    expect(result.ok).toBe(true);
    expect(result.serviceId).toBe('canva');
    expect(mocks.executeServicePreset).toHaveBeenCalledWith('canva', 'exchange_oauth_code', {
      code: 'auth-code',
      code_verifier: 'pkce-verifier',
      redirect_uri: 'http://127.0.0.1:8787/oauth/callback',
    }, 'secret-guard');
  });
});
