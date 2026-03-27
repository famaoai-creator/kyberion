import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeReadFile: vi.fn(),
  safeWriteFile: vi.fn(),
  safeReaddir: vi.fn(),
  safeStat: vi.fn(),
  safeFsyncFile: vi.fn(),
  safeExistsSync: vi.fn(),
  ledgerRecord: vi.fn(),
  pathResolve: vi.fn((p: string) => (path.isAbsolute(p) ? p : `/repo/${p}`)),
  pathRootDir: vi.fn(() => '/repo'),
}));

vi.mock('./secure-io.js', () => ({
  safeReadFile: mocks.safeReadFile,
  safeWriteFile: mocks.safeWriteFile,
  safeReaddir: mocks.safeReaddir,
  safeStat: mocks.safeStat,
  safeFsyncFile: mocks.safeFsyncFile,
  safeExistsSync: mocks.safeExistsSync,
}));

vi.mock('./core.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./ledger.js', () => ({
  ledger: {
    record: mocks.ledgerRecord,
  },
}));

vi.mock('./path-resolver.js', () => ({
  resolve: mocks.pathResolve,
  rootDir: mocks.pathRootDir,
}));

function setupDefaultIo() {
  mocks.safeExistsSync.mockReturnValue(false);
  mocks.safeReadFile.mockReturnValue('{}');
  mocks.safeReaddir.mockReturnValue([]);
  mocks.safeStat.mockReturnValue({ isDirectory: () => false });
}

describe('secret-guard branch coverage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    delete process.env.MISSION_ID;
    delete process.env.AUTHORIZED_SCOPE;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.GITHUB_TOKEN;

    mocks.safeReadFile.mockReset();
    mocks.safeWriteFile.mockReset();
    mocks.safeReaddir.mockReset();
    mocks.safeStat.mockReset();
    mocks.safeFsyncFile.mockReset();
    mocks.safeExistsSync.mockReset();
    mocks.ledgerRecord.mockReset();
    mocks.pathResolve.mockReset();
    mocks.pathRootDir.mockReset();
    mocks.pathResolve.mockImplementation((p: string) => (path.isAbsolute(p) ? p : `/repo/${p}`));
    mocks.pathRootDir.mockReturnValue('/repo');
    setupDefaultIo();
  });

  it('loads nested personal secrets on module init and resolves from cache', async () => {
    mocks.safeReaddir.mockImplementation((p: string) => {
      if (p.endsWith('/knowledge/personal/connections')) return ['slack.json', 'github', 'README.txt'];
      if (p.endsWith('/knowledge/personal/connections/github')) return ['main.json'];
      return [];
    });
    mocks.safeStat.mockImplementation((p: string) => ({
      isDirectory: () => p.endsWith('/github'),
    }));
    mocks.safeReadFile.mockImplementation((p: string) => {
      if (p.endsWith('/knowledge/personal/connections/slack.json')) return JSON.stringify({ bot_token: 'xoxb-from-file' });
      if (p.endsWith('/knowledge/personal/connections/github/main.json')) return JSON.stringify({ nested: { token: 'gh-from-file' } });
      return '{}';
    });

    const mod = await import('./secret-guard.js');
    expect(mod.getSecret('SLACK_BOT_TOKEN')).toBe('xoxb-from-file');
    expect(mod.getSecret('GITHUB_TOKEN')).toBe('gh-from-file');
  });

  it('getSecret enforces TIBA and SHIELD branches', async () => {
    const mod = await import('./secret-guard.js');
    process.env.SLACK_BOT_TOKEN = 'xoxb-env';
    process.env.GITHUB_TOKEN = 'gh-env';

    process.env.AUTHORIZED_SCOPE = 'github';
    expect(() => mod.getSecret('SLACK_BOT_TOKEN', 'slack')).toThrow(/TIBA_VIOLATION/);

    process.env.AUTHORIZED_SCOPE = 'slack';
    expect(() => mod.getSecret('GITHUB_TOKEN', 'slack')).toThrow(/SHIELD_VIOLATION/);
  });

  it('getSecret accepts authorized scope and active grant, and tracks long secrets only', async () => {
    mocks.safeExistsSync.mockImplementation((p: string) => p.endsWith('/active/shared/auth-grants.json'));
    mocks.safeReadFile.mockImplementation((p: string) => {
      if (p.endsWith('/active/shared/auth-grants.json')) {
        return JSON.stringify([
          {
            missionId: 'MSN-1',
            serviceId: 'slack',
            expiresAt: Date.now() + 60_000,
          },
        ]);
      }
      return '{}';
    });
    process.env.MISSION_ID = 'MSN-1';
    process.env.SLACK_BOT_TOKEN = 'xoxb-very-long-secret-token';

    const mod = await import('./secret-guard.js');
    expect(mod.getSecret('SLACK_BOT_TOKEN', 'slack')).toBe('xoxb-very-long-secret-token');
    expect(mod.getActiveSecrets()).toContain('xoxb-very-long-secret-token');

    process.env.AUTHORIZED_SCOPE = 'slack';
    process.env.SLACK_SHORT = 'short';
    expect(mod.getSecret('SLACK_SHORT', 'slack')).toBe('short');
    expect(mod.getActiveSecrets()).not.toContain('short');
  });

  it('loads from vault fallback and returns null for non-string values', async () => {
    mocks.safeReadFile.mockImplementation((p: string) => {
      if (p.endsWith('/vault/secrets/secrets.json')) {
        return JSON.stringify({ VAULT_TOKEN: 'vault-value', NUMBER_VALUE: 42 });
      }
      return '{}';
    });

    const mod = await import('./secret-guard.js');
    expect(mod.getSecret('VAULT_TOKEN')).toBe('vault-value');
    expect(mod.getSecret('NUMBER_VALUE')).toBeNull();
    expect(mod.getSecret('MISSING_VALUE')).toBeNull();
  });

  it('grantAccess/checkAuthority/storeConnectionDocument and loadConnectionDocument branches', async () => {
    mocks.safeExistsSync.mockImplementation((p: string) => (
      p.endsWith('/active/shared/auth-grants.json') || p.endsWith('/knowledge/personal/connections/slack.json')
    ));
    mocks.safeReadFile.mockImplementation((p: string) => {
      if (p.endsWith('/active/shared/auth-grants.json')) {
        return JSON.stringify([
          { missionId: 'OLD', serviceId: 'slack', expiresAt: Date.now() - 1_000 },
          { missionId: 'MSN-A', authority: 'secrets:rotate', expiresAt: Date.now() + 60_000 },
        ]);
      }
      if (p.endsWith('/knowledge/personal/connections/slack.json')) {
        return '{"token":"old-token"}';
      }
      return '{}';
    });

    const mod = await import('./secret-guard.js');

    mod.grantAccess('MSN-B', 'slack', 1, false);
    expect(mocks.safeWriteFile).toHaveBeenCalledWith(
      '/repo/active/shared/auth-grants.json',
      expect.stringContaining('"serviceId": "slack"'),
    );

    mod.grantAccess('MSN-C', 'secrets:admin', 1, true);
    expect(mocks.safeWriteFile).toHaveBeenCalledWith(
      '/repo/active/shared/auth-grants.json',
      expect.stringContaining('"authority": "secrets:admin"'),
    );

    expect(mod.checkAuthority('MSN-A', 'secrets:rotate')).toBe(true);
    expect(mod.checkAuthority('MSN-A', 'secrets:other')).toBe(false);

    const stored = mod.storeConnectionDocument(
      'Slack',
      { token: 'new-token', nested: { a: 1 } },
      { missionId: 'MSN-B', actor: 'tester' },
    );
    expect(stored.path.endsWith('knowledge/personal/connections/slack.json')).toBe(true);
    expect(stored.changedKeys).toEqual(['nested', 'token']);
    expect(mocks.safeWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('.bak'),
      expect.any(String),
    );
    expect(mocks.ledgerRecord).toHaveBeenCalledWith(
      'CONFIG_CHANGE',
      expect.objectContaining({
        mission_id: 'MSN-B',
        role: 'tester',
        service_id: 'Slack',
      }),
    );

    expect(mod.loadConnectionDocument('Slack')).toEqual({ token: 'old-token' });
    mocks.safeReadFile.mockImplementation(() => '{bad json');
    expect(mod.loadConnectionDocument('Slack')).toEqual({});
  });

  it('clears existing service cache entries when storing a connection document', async () => {
    mocks.safeReaddir.mockImplementation((p: string) => (
      p.endsWith('/knowledge/personal/connections') ? ['slack.json', 'github.json'] : []
    ));
    mocks.safeStat.mockReturnValue({ isDirectory: () => false });
    mocks.safeReadFile.mockImplementation((p: string) => {
      if (p.endsWith('/knowledge/personal/connections/slack.json')) {
        return JSON.stringify({ token: 'old-cached-token' });
      }
      if (p.endsWith('/knowledge/personal/connections/github.json')) {
        return JSON.stringify({ token: 'gh-keep' });
      }
      return '{}';
    });
    mocks.safeExistsSync.mockReturnValue(false);

    const mod = await import('./secret-guard.js');
    expect(mod.getSecret('SLACK_TOKEN')).toBe('old-cached-token');

    mod.storeConnectionDocument('slack', { token: 'new-cached-token' }, { backup: false });
    expect(mod.getSecret('SLACK_TOKEN')).toBe('new-cached-token');
    expect(mod.getSecret('GITHUB_TOKEN')).toBe('gh-keep');
  });

  it('returns false from checkAuthority when grants file is invalid JSON', async () => {
    mocks.safeExistsSync.mockImplementation((p: string) => p.endsWith('/active/shared/auth-grants.json'));
    mocks.safeReadFile.mockImplementation((p: string) => (
      p.endsWith('/active/shared/auth-grants.json') ? '{not-json' : '{}'
    ));

    const mod = await import('./secret-guard.js');
    expect(mod.checkAuthority('MSN-X', 'secrets:rotate')).toBe(false);
  });

  it('isSecretPath checks all configured secret roots', async () => {
    const mod = await import('./secret-guard.js');
    expect(mod.isSecretPath('/repo/vault/secrets/secrets.json')).toBe(true);
    expect(mod.isSecretPath('/repo/knowledge/personal/connections/slack.json')).toBe(true);
    expect(mod.isSecretPath('/repo/active/shared/auth-grants.json')).toBe(true);
    expect(mod.isSecretPath('/tmp/not-secret.txt')).toBe(false);
  });
});
import * as path from 'node:path';
