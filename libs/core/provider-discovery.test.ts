import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  homedir: vi.fn(() => '/tmp/provider-discovery-test'),
}));

vi.mock('node:child_process', () => ({
  spawnSync: mocks.spawnSync,
}));

vi.mock('node:fs', () => ({
  readFileSync: mocks.readFileSync,
  writeFileSync: mocks.writeFileSync,
  existsSync: mocks.existsSync,
  mkdirSync: mocks.mkdirSync,
  unlinkSync: mocks.unlinkSync,
}));

vi.mock('node:os', () => ({
  homedir: mocks.homedir,
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
    mocks.existsSync.mockReturnValue(false);
    mocks.mkdirSync.mockReturnValue(undefined);
    mocks.writeFileSync.mockReturnValue(undefined);
    mocks.unlinkSync.mockReturnValue(undefined);
    mocks.readFileSync.mockImplementation(() => {
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
  });
});
