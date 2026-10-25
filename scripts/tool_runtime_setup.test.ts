import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  secureFetch: vi.fn(),
  resolveManagedBinaryArtifact: vi.fn(),
  resolveManagedBinaryPath: vi.fn(),
  getToolRuntimeRecord: vi.fn(),
  findInstalledManagedBinary: vi.fn(),
  safeExecResult: vi.fn(),
  probeToolRuntime: vi.fn(),
  resolveManagedToolPythonBin: vi.fn(),
  markToolRuntimeInstalled: vi.fn(),
}));

vi.mock('@agent/core/network', () => ({ secureFetch: mocks.secureFetch }));

vi.mock('@agent/core/tool/tool-runtime-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/tool/tool-runtime-registry')>()),
  resolveManagedBinaryArtifact: mocks.resolveManagedBinaryArtifact,
  resolveManagedBinaryPath: mocks.resolveManagedBinaryPath,
  getToolRuntimeRecord: mocks.getToolRuntimeRecord,
  findInstalledManagedBinary: mocks.findInstalledManagedBinary,
  probeToolRuntime: mocks.probeToolRuntime,
  resolveManagedToolPythonBin: mocks.resolveManagedToolPythonBin,
  markToolRuntimeInstalled: mocks.markToolRuntimeInstalled,
}));

vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/secure-io')>()),
  safeExecResult: mocks.safeExecResult,
}));

const { assertPinnedSha256, installManagedBinary, installTool, inspectTool, resolveToolSelection } =
  await import('./tool_runtime_setup.js');

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
    mocks.probeToolRuntime.mockReturnValue({
      tool: { ecosystem: 'system' },
      trial_backend: { command: 'tool', args: ['--version'] },
    });
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

  it('skips an all-zero pin without downloading so the install_backend fallback runs', async () => {
    mocks.resolveManagedBinaryArtifact.mockReturnValue({
      url: 'https://example.invalid/tool',
      sha256: '0'.repeat(64),
    });
    await expect(installManagedBinary('yt_dlp')).resolves.toBeNull();
    expect(mocks.secureFetch).not.toHaveBeenCalled();
  });
});

describe('tool runtime setup isolation', () => {
  const managedPath = '/managed/python-runtime';
  const backend = { command: 'uv', args: ['pip', 'install', 'example-package'] };
  beforeEach(() => {
    vi.clearAllMocks();
    const tool = {
      display_name: 'Example',
      ecosystem: 'python',
      status: 'active',
      platforms: ['any'],
    };
    mocks.getToolRuntimeRecord.mockReturnValue(tool);
    mocks.probeToolRuntime.mockReturnValue({
      tool,
      managed_env_path: managedPath,
      install_backend: backend,
      trial_backend: { command: 'python3', args: ['-c', 'import example_package'] },
    });
    mocks.resolveManagedToolPythonBin.mockReturnValue(null);
    mocks.findInstalledManagedBinary.mockReturnValue(null);
    mocks.safeExecResult.mockReturnValue({ status: 0, stdout: 'ok', stderr: '' });
  });

  it('targets uv pip installs at the tool environment even when system Python is healthy', () => {
    installTool('example');
    expect(mocks.safeExecResult).toHaveBeenCalledWith(
      'uv',
      expect.arrayContaining([
        'pip',
        'install',
        '--python',
        expect.stringContaining(managedPath),
        'example-package',
      ]),
      expect.any(Object)
    );
    expect(mocks.safeExecResult).not.toHaveBeenCalledWith(
      'python3',
      expect.anything(),
      expect.anything()
    );
  });

  it('does not run unsupported platform commands or mark them installed', () => {
    mocks.getToolRuntimeRecord.mockReturnValue({
      platforms: [],
      display_name: 'Example',
      status: 'active',
    });
    expect(installTool('example').status).toBe('unsupported');
    expect(inspectTool('example').status).toBe('unsupported');
    expect(mocks.safeExecResult).not.toHaveBeenCalled();
    expect(mocks.markToolRuntimeInstalled).not.toHaveBeenCalled();
  });

  it('does not record failed installs', () => {
    mocks.safeExecResult.mockImplementation((command, args) => ({
      status: command === 'uv' && args[0] === 'pip' ? 1 : 0,
      stdout: '',
      stderr: 'failed',
    }));
    expect(() => installTool('example')).toThrow('failed');
    expect(mocks.markToolRuntimeInstalled).not.toHaveBeenCalled();
  });

  it('adopts a healthy host tool without requiring an installer', () => {
    mocks.probeToolRuntime.mockReturnValue({
      tool: { display_name: 'Poppler', ecosystem: 'system' },
      trial_backend: { command: 'pdftoppm', args: ['-v'] },
      install_backend: null,
    });
    expect(installTool('poppler').status).toBe('ready');
    expect(mocks.markToolRuntimeInstalled).toHaveBeenCalledWith('poppler', expect.any(Object));
  });
});

describe('toolset registration', () => {
  it('selects only declared dependencies and deduplicates explicit tool ids', () => {
    expect(resolveToolSelection(undefined, undefined, 'document_review')).toEqual([
      'poppler',
      'libreoffice',
    ]);
    expect(resolveToolSelection(undefined, undefined, 'render')).toEqual(['hyperframes', 'ffmpeg']);
    expect(resolveToolSelection(undefined, 'ffmpeg,ffmpeg')).toEqual(['ffmpeg']);
  });
  it('rejects unknown groups, unknown tools and conflicting selectors before execution', () => {
    expect(() => resolveToolSelection(undefined, undefined, 'missing')).toThrow(
      'Unknown or empty toolset'
    );
    expect(() => resolveToolSelection('missing')).toThrow('Unknown tool_id');
    expect(() => resolveToolSelection('ffmpeg', undefined, 'render')).toThrow('not both');
  });
});
