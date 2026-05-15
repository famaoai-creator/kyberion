import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  safeReadFile: vi.fn(),
  safeWriteFile: vi.fn(),
  safeExistsSync: vi.fn(),
  safeMkdir: vi.fn(),
  safeUnlinkSync: vi.fn(),
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

vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    rootResolve: mocks.rootResolve,
    shared: mocks.shared,
  },
}));

describe('provider-discovery', () => {
  it('falls back to npx codex when the codex binary is not on PATH', async () => {
    mocks.spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'codex') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'npx' && args[0] === 'codex' && args[1] === '--version') {
        return { status: 0, stdout: '0.0.1', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    mocks.safeExistsSync.mockReturnValue(false);
    mocks.safeMkdir.mockReturnValue(undefined);
    mocks.safeWriteFile.mockReturnValue(undefined);
    mocks.safeUnlinkSync.mockReturnValue(undefined);
    mocks.safeReadFile.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const { discoverProviders } = await import('./provider-discovery.js');
    const providers = discoverProviders(true);
    const codex = providers.find((provider) => provider.provider === 'codex');

    expect(codex).toMatchObject({
      provider: 'codex',
      installed: true,
      version: '0.0.1',
      healthy: true,
    });
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'npx',
      ['codex', '--version'],
      expect.objectContaining({
        timeout: 15000,
      }),
    );
    expect(mocks.rootResolve).toHaveBeenCalledWith('active/shared/runtime/provider-cache.json');
    expect(mocks.safeWriteFile).toHaveBeenCalledWith(
      '/repo/active/shared/runtime/provider-cache.json',
      expect.any(String),
      { encoding: 'utf8' },
    );
  });
});
