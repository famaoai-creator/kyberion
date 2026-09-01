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
  schemaPath: '/repo/knowledge/product/schemas/provider-capabilities.schema.json',
  schema: {
    type: 'object',
    required: ['providers'],
    properties: {
      version: { type: 'string' },
      provenance: { type: 'object' },
      providers: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          required: ['models', 'capabilities', 'modelCapabilities'],
          properties: {
            models: { type: 'array', items: { type: 'string' } },
            capabilities: { type: 'array', items: { type: 'string' } },
            modelCapabilities: {
              type: 'object',
              additionalProperties: { type: 'array', items: { type: 'string' } },
            },
            provenance: { type: 'object' },
          },
        },
      },
    },
  },
}));

vi.mock('node:child_process', () => ({ spawnSync: mocks.spawnSync }));

vi.mock('./secure-io.js', () => ({
  safeReadFile: mocks.safeReadFile,
  safeWriteFile: mocks.safeWriteFile,
  safeExistsSync: mocks.safeExistsSync,
  safeMkdir: mocks.safeMkdir,
  safeUnlinkSync: mocks.safeUnlinkSync,
}));

vi.mock('./foundation/json.js', () => ({
  readJson: (filePath: string) =>
    JSON.parse(
      filePath === mocks.schemaPath
        ? JSON.stringify(mocks.schema)
        : String(mocks.safeReadFile(filePath))
    ),
}));

vi.mock('./foundation/io.js', () => ({
  getFoundationIo: () => ({
    loadJson: (filePath: string) => JSON.parse(String(mocks.safeReadFile(filePath))),
    loadJsonIfPresent: () => null,
    appendFile: () => undefined,
    exists: (filePath: string) => mocks.safeExistsSync(filePath),
    readFile: (filePath: string) => String(mocks.safeReadFile(filePath)),
    stat: (filePath: string) => ({
      mtimeMs: 0,
      size: String(mocks.safeReadFile(filePath)).length,
    }),
    writeFile: () => undefined,
  }),
  registerFoundationIo: vi.fn(),
}));

vi.mock('./path-resolver.js', () => ({
  pathResolver: { rootResolve: mocks.rootResolve, shared: mocks.shared },
}));

const CATALOG_PATH = '/repo/knowledge/product/orchestration/provider-capabilities.json';
const FALLBACK_CATALOG_PATH =
  '/repo/knowledge/product/orchestration/provider-capabilities.fallback.json';

function claudeInstalled() {
  mocks.spawnSync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'which' && args[0] === 'claude')
      return { status: 0, stdout: '/usr/bin/claude', stderr: '' };
    if (cmd === 'claude' && args[0] === '--version')
      return { status: 0, stdout: 'claude 1.0.0', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  });
  mocks.safeExistsSync.mockImplementation(
    (filePath: string) => filePath === CATALOG_PATH || filePath === FALLBACK_CATALOG_PATH
  );
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
      if (p === FALLBACK_CATALOG_PATH) {
        return JSON.stringify({
          version: '1.0',
          providers: {
            claude: {
              models: ['sonnet', 'opus', 'haiku'],
              capabilities: [
                'reasoning',
                'planning',
                'coordination',
                'analysis',
                'review',
                'code',
                'long_context',
                'structured_json',
              ],
              modelCapabilities: {
                sonnet: [
                  'reasoning',
                  'planning',
                  'coordination',
                  'analysis',
                  'review',
                  'code',
                  'long_context',
                  'structured_json',
                ],
                opus: [
                  'reasoning',
                  'planning',
                  'coordination',
                  'analysis',
                  'review',
                  'code',
                  'long_context',
                  'structured_json',
                  'deep_reasoning',
                ],
                haiku: ['conversation', 'summarization', 'low_latency', 'structured_json'],
              },
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
      if (p === FALLBACK_CATALOG_PATH) {
        return JSON.stringify({
          version: '1.0',
          providers: {
            claude: {
              models: ['sonnet', 'opus', 'haiku'],
              capabilities: [
                'reasoning',
                'planning',
                'coordination',
                'analysis',
                'review',
                'code',
                'long_context',
                'structured_json',
              ],
              modelCapabilities: {
                sonnet: [
                  'reasoning',
                  'planning',
                  'coordination',
                  'analysis',
                  'review',
                  'code',
                  'long_context',
                  'structured_json',
                ],
                opus: [
                  'reasoning',
                  'planning',
                  'coordination',
                  'analysis',
                  'review',
                  'code',
                  'long_context',
                  'structured_json',
                  'deep_reasoning',
                ],
                haiku: ['conversation', 'summarization', 'low_latency', 'structured_json'],
              },
            },
          },
        });
      }
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
        return JSON.stringify({
          version: '1.0',
          providers: { claude: { models: 'not-an-array' } },
        });
      }
      if (p === FALLBACK_CATALOG_PATH) {
        return JSON.stringify({
          version: '1.0',
          providers: {
            claude: {
              models: ['sonnet', 'opus', 'haiku'],
              capabilities: [
                'reasoning',
                'planning',
                'coordination',
                'analysis',
                'review',
                'code',
                'long_context',
                'structured_json',
              ],
              modelCapabilities: {
                sonnet: [
                  'reasoning',
                  'planning',
                  'coordination',
                  'analysis',
                  'review',
                  'code',
                  'long_context',
                  'structured_json',
                ],
                opus: [
                  'reasoning',
                  'planning',
                  'coordination',
                  'analysis',
                  'review',
                  'code',
                  'long_context',
                  'structured_json',
                  'deep_reasoning',
                ],
                haiku: ['conversation', 'summarization', 'low_latency', 'structured_json'],
              },
            },
          },
        });
      }
      throw new Error('ENOENT');
    });

    const { discoverProviders } = await import('./provider-discovery.js');
    const claude = discoverProviders(true).find((p) => p.provider === 'claude');
    expect(Array.isArray(claude?.models)).toBe(true);
    expect(claude?.models).toContain('sonnet');
  });
});
