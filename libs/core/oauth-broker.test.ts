import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeReadFile: vi.fn(),
  safeWriteFile: vi.fn(),
  safeExistsSync: vi.fn(),
  safeMkdir: vi.fn(),
  safeReaddir: vi.fn(),
  safeLstat: vi.fn(),
  safeCreateExclusiveFileSync: vi.fn(),
  safeUnlinkSync: vi.fn(),
  safeFsyncFile: vi.fn(),
  resolveServiceBinding: vi.fn(),
  loadServiceEndpointsCatalog: vi.fn(),
  getServicePresetRecord: vi.fn(),
  executeServicePreset: vi.fn(),
  loadConnectionDocument: vi.fn(),
  storeConnectionDocument: vi.fn(),
}));

vi.mock('./secure-io.js', async () => {
  const actual = (await vi.importActual('./secure-io.js')) as any;
  return {
    ...actual,
    safeReadFile: mocks.safeReadFile,
    safeWriteFile: mocks.safeWriteFile,
    safeExistsSync: mocks.safeExistsSync,
    safeMkdir: mocks.safeMkdir,
    safeReaddir: mocks.safeReaddir,
    safeLstat: mocks.safeLstat,
    safeCreateExclusiveFileSync: mocks.safeCreateExclusiveFileSync,
    safeUnlinkSync: mocks.safeUnlinkSync,
    safeFsyncFile: mocks.safeFsyncFile,
    loadJson: <T>(filePath: string): T =>
      JSON.parse(String(mocks.safeReadFile(filePath, { encoding: 'utf8' }))) as T,
    loadJsonIfPresent: <T>(filePath: string): T | null => {
      try {
        return JSON.parse(String(mocks.safeReadFile(filePath, { encoding: 'utf8' }))) as T;
      } catch {
        return null;
      }
    },
  };
});

vi.mock('./foundation/json.js', async () => {
  const actual =
    await vi.importActual<typeof import('./foundation/json.js')>('./foundation/json.js');
  const read = <T>(filePath: string): T =>
    JSON.parse(String(mocks.safeReadFile(filePath, { encoding: 'utf8' }))) as T;
  const readIfPresent = <T>(filePath: string): T | null => {
    try {
      return read<T>(filePath);
    } catch {
      return null;
    }
  };
  return {
    ...actual,
    loadJson: read,
    loadJsonIfPresent: readIfPresent,
    readJson: read,
    readJsonIfPresent: readIfPresent,
  };
});

vi.mock('./service-binding.js', () => ({
  resolveServiceBinding: mocks.resolveServiceBinding,
  loadServiceEndpointsCatalog: mocks.loadServiceEndpointsCatalog,
}));

vi.mock('./service-preset-registry.js', () => ({
  getServicePresetRecord: mocks.getServicePresetRecord,
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
    mocks.safeLstat.mockReturnValue({ isFile: () => true });
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
        canva: { preset_path: 'knowledge/product/orchestration/service-presets/canva.json' },
      },
    });
    mocks.getServicePresetRecord.mockReturnValue({
      service_id: 'canva',
      operations: {},
      oauth: {
        authorize_url: 'https://www.canva.com/api/oauth/authorize',
        token_operation: 'exchange_oauth_code',
        refresh_operation: 'refresh_oauth_token',
        pkce: true,
        scopes: ['design:meta:read', 'asset:write'],
      },
    });
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('canva.json')) {
        return JSON.stringify({
          service_id: 'canva',
          operations: {},
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

  it('rejects caller-supplied state and runtime redirect overrides', async () => {
    const { beginInteractiveServiceOAuth, beginServiceOAuth } = await import('./oauth-broker.js');

    expect(() => beginServiceOAuth('canva', { state: 'caller-state' })).toThrow('generated');
    expect(() =>
      beginServiceOAuth('canva', { redirectUri: 'https://attacker.example/callback' })
    ).toThrow('interactive human setup path');
    expect(() =>
      beginInteractiveServiceOAuth('canva', { redirectUri: 'https://attacker.example/callback' })
    ).toThrow('loopback HTTP');
    expect(
      beginInteractiveServiceOAuth('canva', {
        redirectUri: 'http://127.0.0.1:8787/oauth/callback',
      }).redirectUri
    ).toBe('http://127.0.0.1:8787/oauth/callback');
  });

  it('does not allow callers to widen the preset scope allowlist', async () => {
    const { beginServiceOAuth } = await import('./oauth-broker.js');

    expect(() => beginServiceOAuth('canva', { scopes: ['account:delete'] })).toThrow(
      'preset allowlist'
    );
  });

  it('exchanges an oauth code and persists refreshed credentials', async () => {
    mocks.safeExistsSync.mockImplementation(
      (filePath: string) =>
        filePath.includes('/active/shared/tmp/oauth/canva') ||
        filePath.includes('/active/shared/tmp/oauth/canva/test-state.json')
    );
    mocks.loadServiceEndpointsCatalog.mockReturnValue({
      default_pattern: 'https://api.{service_id}.com/v1',
      services: {
        canva: { preset_path: 'knowledge/product/orchestration/service-presets/canva.json' },
      },
    });
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('service-presets/canva.json')) {
        return JSON.stringify({
          service_id: 'canva',
          operations: {},
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
          expiresAt: '2099-03-23T00:00:00.000Z',
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

    expect(mocks.executeServicePreset).toHaveBeenCalledWith(
      'canva',
      'exchange_oauth_code',
      {
        code: 'auth-code',
        code_verifier: 'pkce-verifier',
        redirect_uri: 'http://127.0.0.1:8787/oauth/callback',
      },
      'secret-guard'
    );
    expect(mocks.storeConnectionDocument).toHaveBeenCalledWith(
      'canva',
      expect.objectContaining({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        token_type: 'Bearer',
        scope: 'design:meta:read',
        redirect_uri: 'http://127.0.0.1:8787/oauth/callback',
      }),
      { actor: 'oauth_broker' }
    );
    expect(result.persisted_path).toContain('connections/canva.json');
    expect(mocks.safeWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('/active/shared/tmp/oauth/canva/test-state.json'),
      expect.stringContaining('callbackExpiresAt')
    );
    expect(mocks.safeUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining('/active/shared/tmp/oauth/canva/test-state.json')
    );
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

    expect(mocks.executeServicePreset).toHaveBeenCalledWith(
      'canva',
      'refresh_oauth_token',
      {
        refresh_token: 'stored-refresh-token',
      },
      'secret-guard'
    );
    expect(mocks.storeConnectionDocument).toHaveBeenCalledWith(
      'canva',
      expect.objectContaining({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
      }),
      { actor: 'oauth_broker' }
    );
  });

  it('completes a generic callback by resolving the service from state', async () => {
    mocks.safeExistsSync.mockImplementation(
      (filePath: string) =>
        filePath.includes('/active/shared/tmp/oauth') ||
        filePath.includes('/active/shared/tmp/oauth/canva/test-state.json')
    );
    mocks.safeReaddir.mockImplementation((dirPath: string) => {
      if (dirPath.endsWith('/active/shared/tmp/oauth')) return ['canva'];
      if (dirPath.endsWith('/active/shared/tmp/oauth/canva')) return ['test-state.json'];
      return [];
    });
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('service-presets/canva.json')) {
        return JSON.stringify({
          service_id: 'canva',
          operations: {},
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
          expiresAt: '2099-03-23T00:00:00.000Z',
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
    expect(mocks.executeServicePreset).toHaveBeenCalledWith(
      'canva',
      'exchange_oauth_code',
      {
        code: 'auth-code',
        code_verifier: 'pkce-verifier',
        redirect_uri: 'http://127.0.0.1:8787/oauth/callback',
      },
      'secret-guard'
    );
  });

  it('rejects a callback whose service conflicts with the stored state', async () => {
    mocks.safeExistsSync.mockImplementation((filePath: string) =>
      filePath.includes('/active/shared/tmp/oauth')
    );
    mocks.safeReaddir.mockImplementation((dirPath: string) => {
      if (dirPath.endsWith('/active/shared/tmp/oauth')) return ['canva'];
      if (dirPath.endsWith('/active/shared/tmp/oauth/canva')) return ['test-state.json'];
      return [];
    });
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('/active/shared/tmp/oauth/canva/test-state.json')) {
        return JSON.stringify({
          serviceId: 'canva',
          state: 'test-state',
          scopes: [],
          createdAt: '2026-03-23T00:00:00.000Z',
          expiresAt: '2099-03-23T00:00:00.000Z',
        });
      }
      return '';
    });

    const { completeOAuthCallback } = await import('./oauth-broker.js');
    await expect(
      completeOAuthCallback({
        serviceId: 'slack',
        code: 'auth-code',
        state: 'test-state',
      })
    ).rejects.toThrow('does not match state');
    expect(mocks.executeServicePreset).not.toHaveBeenCalled();
  });

  it('rejects a callback with an unknown state before token exchange', async () => {
    const { completeOAuthCallback } = await import('./oauth-broker.js');
    await expect(
      completeOAuthCallback({
        serviceId: 'canva',
        code: 'auth-code',
        state: 'unknown-state',
      })
    ).rejects.toThrow('invalid or expired');
    expect(mocks.executeServicePreset).not.toHaveBeenCalled();
  });

  it('requires state on successful callbacks', async () => {
    const { completeOAuthCallback } = await import('./oauth-broker.js');

    await expect(completeOAuthCallback({ serviceId: 'canva', code: 'auth-code' })).rejects.toThrow(
      'requires state'
    );
    expect(mocks.executeServicePreset).not.toHaveBeenCalled();
  });

  it('requires state on direct code exchange calls', async () => {
    const { exchangeServiceOAuthCode } = await import('./oauth-broker.js');

    await expect(exchangeServiceOAuthCode('canva', { code: 'auth-code' })).rejects.toThrow(
      'requires state'
    );
    expect(mocks.executeServicePreset).not.toHaveBeenCalled();
  });

  it('self-destructs a pending session when token exchange fails', async () => {
    mocks.safeExistsSync.mockImplementation(
      (filePath: string) =>
        filePath.includes('/active/shared/tmp/oauth') ||
        filePath.includes('/active/shared/tmp/oauth/canva/test-state.json')
    );
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('service-presets/canva.json')) {
        return JSON.stringify({
          service_id: 'canva',
          operations: {},
          oauth: {
            authorize_url: 'https://www.canva.com/api/oauth/authorize',
            token_operation: 'exchange_oauth_code',
            pkce: true,
          },
        });
      }
      if (filePath.includes('/active/shared/tmp/oauth/canva/test-state.json')) {
        return JSON.stringify({
          serviceId: 'canva',
          state: 'test-state',
          codeVerifier: 'pkce-verifier',
          scopes: ['design:meta:read'],
          createdAt: '2026-03-23T00:00:00.000Z',
          expiresAt: '2099-03-23T00:00:00.000Z',
        });
      }
      return '';
    });
    mocks.executeServicePreset.mockRejectedValue(new Error('token exchange failed'));

    const { exchangeServiceOAuthCode } = await import('./oauth-broker.js');
    await expect(
      exchangeServiceOAuthCode('canva', { code: 'auth-code', state: 'test-state' })
    ).rejects.toThrow('token exchange failed');
    expect(mocks.safeUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining('/active/shared/tmp/oauth/canva/test-state.json')
    );
  });

  it('does not allow callback parameters to override pending PKCE binding', async () => {
    mocks.safeExistsSync.mockImplementation(
      (filePath: string) =>
        filePath.includes('/active/shared/tmp/oauth') ||
        filePath.includes('/active/shared/tmp/oauth/canva/test-state.json')
    );
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('service-presets/canva.json')) {
        return JSON.stringify({
          service_id: 'canva',
          operations: {},
          oauth: {
            authorize_url: 'https://www.canva.com/api/oauth/authorize',
            token_operation: 'exchange_oauth_code',
            pkce: true,
          },
        });
      }
      return JSON.stringify({
        serviceId: 'canva',
        state: 'test-state',
        codeVerifier: 'stored-verifier',
        redirectUri: 'http://127.0.0.1:8787/oauth/callback',
        scopes: [],
        createdAt: '2026-03-23T00:00:00.000Z',
        expiresAt: '2099-03-23T00:00:00.000Z',
      });
    });

    const { exchangeServiceOAuthCode } = await import('./oauth-broker.js');
    await expect(
      exchangeServiceOAuthCode('canva', {
        code: 'auth-code',
        state: 'test-state',
        codeVerifier: 'attacker-verifier',
        redirectUri: 'http://127.0.0.1:8787/attacker',
      })
    ).rejects.toThrow('redirect URI');
    expect(mocks.executeServicePreset).not.toHaveBeenCalled();
  });

  it('claims a pending state once when exchanges race', async () => {
    let sessionExists = true;
    mocks.safeExistsSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('/active/shared/tmp/oauth/canva')) return true;
      if (filePath.endsWith('/active/shared/tmp/oauth/canva/test-state.json')) {
        return sessionExists;
      }
      return false;
    });
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('service-presets/canva.json')) {
        return JSON.stringify({
          service_id: 'canva',
          operations: {},
          oauth: {
            authorize_url: 'https://www.canva.com/api/oauth/authorize',
            token_operation: 'exchange_oauth_code',
            pkce: true,
          },
        });
      }
      return JSON.stringify({
        serviceId: 'canva',
        state: 'test-state',
        codeVerifier: 'pkce-verifier',
        scopes: ['design:meta:read'],
        createdAt: '2026-03-23T00:00:00.000Z',
        expiresAt: '2099-03-23T00:00:00.000Z',
      });
    });
    mocks.safeUnlinkSync.mockImplementation(() => {
      sessionExists = false;
    });
    mocks.executeServicePreset.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { access_token: 'access-token' };
    });

    const { exchangeServiceOAuthCode } = await import('./oauth-broker.js');
    const results = await Promise.allSettled([
      exchangeServiceOAuthCode('canva', { code: 'auth-code-a', state: 'test-state' }),
      exchangeServiceOAuthCode('canva', { code: 'auth-code-b', state: 'test-state' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(mocks.executeServicePreset).toHaveBeenCalledTimes(1);
  });
});
