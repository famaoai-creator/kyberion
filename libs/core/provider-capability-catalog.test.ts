import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('node:child_process', () => ({ spawnSync: mocks.spawnSync }));

vi.mock('./secure-io.js', () => ({
  safeReadFile: mocks.safeReadFile,
  safeWriteFile: mocks.safeWriteFile,
  safeExistsSync: mocks.safeExistsSync,
  safeMkdir: mocks.safeMkdir,
  safeUnlinkSync: mocks.safeUnlinkSync,
}));

vi.mock('./path-resolver.js', () => ({
  pathResolver: { rootResolve: mocks.rootResolve, shared: mocks.shared },
}));

const CATALOG_PATH = '/repo/knowledge/public/orchestration/provider-capabilities.json';

function claudeInstalled() {
  mocks.spawnSync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'which' && args[0] === 'claude') return { status: 0, stdout: '/usr/bin/claude', stderr: '' };
    if (cmd === 'claude' && args[0] === '--version') return { status: 0, stdout: 'claude 1.0.0', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  });
  mocks.safeExistsSync.mockReturnValue(false);
  mocks.safeWriteFile.mockReturnValue(undefined);
  mocks.safeMkdir.mockReturnValue(undefined);
  mocks.safeUnlinkSync.mockReturnValue(undefined);
}

describe('provider capability catalog (knowledge-driven)', () => {
  beforeEach(async () => {
    const { clearProviderDiscoveryCache } = await import('./provider-discovery.js');
    clearProviderDiscoveryCache();
    vi.clearAllMocks();
  });

  it('sources provider capabilities from the knowledge catalog when present', async () => {
    claudeInstalled();
    mocks.safeReadFile.mockImplementation((p: string) => {
      if (p === CATALOG_PATH) {
        return JSON.stringify({
          version: '1.0',
          providers: {
            claude: {
              models: ['opus'],
              capabilities: ['reasoning', 'managed_workflow'],
              modelCapabilities: { opus: ['reasoning', 'managed_workflow', 'deep_reasoning'] },
            },
          },
        });
      }
      throw new Error('ENOENT'); // disk cache miss
    });

    const { discoverProviders } = await import('./provider-discovery.js');
    const claude = discoverProviders(true).find((p) => p.provider === 'claude');
    expect(claude?.capabilities).toContain('managed_workflow');
    expect(claude?.models).toEqual(['opus']);
    expect(claude?.modelCapabilities?.opus).toContain('deep_reasoning');
  });

  it('falls back to the built-in baseline when the catalog is malformed', async () => {
    claudeInstalled();
    mocks.safeReadFile.mockImplementation((p: string) => {
      if (p === CATALOG_PATH) return '{ this is not json';
      throw new Error('ENOENT');
    });

    const { discoverProviders } = await import('./provider-discovery.js');
    const claude = discoverProviders(true).find((p) => p.provider === 'claude');
    // built-in baseline ships sonnet/opus/haiku and the reasoning capability
    expect(claude?.capabilities).toContain('reasoning');
    expect(claude?.models).toContain('sonnet');
  });

  it('keeps the built-in baseline for a provider entry that is malformed', async () => {
    claudeInstalled();
    mocks.safeReadFile.mockImplementation((p: string) => {
      if (p === CATALOG_PATH) {
        return JSON.stringify({ version: '1.0', providers: { claude: { models: 'not-an-array' } } });
      }
      throw new Error('ENOENT');
    });

    const { discoverProviders } = await import('./provider-discovery.js');
    const claude = discoverProviders(true).find((p) => p.provider === 'claude');
    expect(Array.isArray(claude?.models)).toBe(true);
    expect(claude?.models).toContain('sonnet');
  });
});
