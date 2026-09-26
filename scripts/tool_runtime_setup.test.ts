import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  secureFetch: vi.fn(),
  resolveManagedBinaryArtifact: vi.fn(),
  resolveManagedBinaryPath: vi.fn(),
  getToolRuntimeRecord: vi.fn(),
  findInstalledManagedBinary: vi.fn(),
  safeExecResult: vi.fn(),
}));

vi.mock('@agent/core/network', () => ({ secureFetch: mocks.secureFetch }));

vi.mock('@agent/core/tool-runtime-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/tool-runtime-registry')>()),
  resolveManagedBinaryArtifact: mocks.resolveManagedBinaryArtifact,
  resolveManagedBinaryPath: mocks.resolveManagedBinaryPath,
  getToolRuntimeRecord: mocks.getToolRuntimeRecord,
  findInstalledManagedBinary: mocks.findInstalledManagedBinary,
}));

vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/secure-io')>()),
  safeExecResult: mocks.safeExecResult,
}));

const { assertPinnedSha256, installManagedBinary } = await import('./tool_runtime_setup.js');

const REAL = '99e67739ed8cf5b985af7cbfa7c76b2bab257b171b2dad21109bd74b4f3bb510';

describe('tool_runtime_setup managed_binary pin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveManagedBinaryPath.mockReturnValue('active/shared/tmp/tool-runtime-test/bin/tool');
    mocks.getToolRuntimeRecord.mockReturnValue({
      display_name: 'Tool',
      managed_binary: { version: '1.0.0' },
      trial_backend: { command: 'tool', args: ['--version'] },
    });
    mocks.findInstalledManagedBinary.mockReturnValue(null);
    mocks.safeExecResult.mockReturnValue({ status: 1, stdout: '', stderr: '' });
  });

  it('accepts a real digest and normalizes case', () => {
    expect(assertPinnedSha256('t', '1', REAL.toUpperCase())).toBe(REAL);
  });

  it.each([['0'.repeat(64)], ['abc'], [''], [undefined], ['g'.repeat(64)]])(
    'rejects placeholder or malformed digest %s',
    (digest) => {
      expect(() => assertPinnedSha256('t', '1', digest)).toThrow('is not pinned');
    }
  );

  it('fails closed on an all-zero pin before any download', async () => {
    mocks.resolveManagedBinaryArtifact.mockReturnValue({
      url: 'https://example.invalid/tool',
      sha256: '0'.repeat(64),
    });
    await expect(installManagedBinary('yt_dlp')).rejects.toThrow('is not pinned');
    expect(mocks.secureFetch).not.toHaveBeenCalled();
  });
});
