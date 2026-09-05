import * as fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  safeReadFile: vi.fn(),
  safeWriteFile: vi.fn(),
  safeExistsSync: vi.fn(),
  safeLstat: vi.fn(() => ({ isFile: () => true })),
  safeMkdir: vi.fn(),
  safeUnlinkSync: vi.fn(),
  rootDir: vi.fn(() => '/repo'),
  rootResolve: vi.fn((relPath: string) => `/repo/${relPath}`),
  shared: vi.fn((relPath: string) => `/repo/active/shared/${relPath}`),
}));

vi.mock('node:child_process', () => ({
  spawnSync: mocks.spawnSync,
}));

vi.mock('./secure-io.js', () => ({
  safeReadFile: mocks.safeReadFile,
  safeWriteFile: mocks.safeWriteFile,
  safeExistsSync: mocks.safeExistsSync,
  safeMkdir: mocks.safeMkdir,
  safeUnlinkSync: mocks.safeUnlinkSync,
}));

vi.mock('./foundation/json.js', () => ({
  readJson: (filePath: string) => JSON.parse(String(mocks.safeReadFile(filePath))),
}));

vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    rootDir: mocks.rootDir,
    rootResolve: mocks.rootResolve,
    knowledge: mocks.rootResolve,
    shared: mocks.shared,
  },
}));

describe('provider-discovery', () => {
  it('marks codex as not installed when the codex binary is not on PATH', async () => {
    mocks.spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'codex') {
        return { status: 1, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    mocks.safeExistsSync.mockReturnValue(false);
    mocks.safeMkdir.mockReturnValue(undefined);
    mocks.safeWriteFile.mockReturnValue(undefined);
    mocks.safeUnlinkSync.mockReturnValue(undefined);
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('provider-discovery-cache.schema.json')) {
        return fs.readFileSync(
          'knowledge/product/schemas/provider-discovery-cache.schema.json',
          'utf8'
        );
      }
      throw new Error('ENOENT');
    });

    const { discoverProviders } = await import('./provider-discovery.js');
    const providers = discoverProviders(true);
    const codex = providers.find((provider) => provider.provider === 'codex');

    expect(codex).toMatchObject({
      provider: 'codex',
      installed: false,
      healthy: false,
    });
    expect(mocks.rootResolve).toHaveBeenCalledWith('active/shared/runtime/provider-cache.json');
    expect(mocks.safeWriteFile).toHaveBeenCalledWith(
      '/repo/active/shared/runtime/provider-cache.json',
      expect.any(String),
      { encoding: 'utf8' }
    );
  });

  it('rejects malformed disk cache records before using cached providers', async () => {
    const { parseProviderDiscoveryCache } = await import('./provider-discovery.js');
    expect(() =>
      parseProviderDiscoveryCache({
        ts: Date.now(),
        providers: [
          {
            provider: 'codex',
            installed: false,
            version: null,
            protocol: 'json-rpc',
            models: [],
            healthy: false,
            unexpected: true,
          },
        ],
      })
    ).toThrow('contains unknown field(s)');
    expect(() =>
      parseProviderDiscoveryCache(
        JSON.parse(
          '{"ts":1,"providers":[{"provider":"codex","installed":false,"version":null,"protocol":"json-rpc","models":[],"healthy":false,"modelCapabilities":{"__proto__":[]}}]}'
        )
      )
    ).toThrow('dangerous JSON key');
  });

  it('uses the governed Cursor CLI binary override during discovery', async () => {
    const previous = process.env.KYBERION_CURSOR_CLI_BIN;
    process.env.KYBERION_CURSOR_CLI_BIN = 'cursor-agent-custom';
    try {
      mocks.spawnSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'cursor-agent-custom' && args[0] === '--version') {
          return { status: 0, stdout: 'cursor-agent 1.0.0', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: '' };
      });
      mocks.safeExistsSync.mockReturnValue(false);
      mocks.safeMkdir.mockReturnValue(undefined);
      mocks.safeWriteFile.mockReturnValue(undefined);
      mocks.safeReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes('provider-discovery-cache.schema.json')) {
          return fs.readFileSync(
            'knowledge/product/schemas/provider-discovery-cache.schema.json',
            'utf8'
          );
        }
        throw new Error('ENOENT');
      });

      const { discoverProviders } = await import('./provider-discovery.js');
      const cursor = discoverProviders(true).find((provider) => provider.provider === 'cursor');

      expect(cursor).toMatchObject({
        provider: 'cursor',
        installed: true,
        healthy: true,
        version: 'cursor-agent 1.0.0',
      });
      expect(mocks.spawnSync).toHaveBeenCalledWith(
        'cursor-agent-custom',
        ['--version'],
        expect.objectContaining({ shell: false })
      );
    } finally {
      if (previous === undefined) delete process.env.KYBERION_CURSOR_CLI_BIN;
      else process.env.KYBERION_CURSOR_CLI_BIN = previous;
    }
  });
});
