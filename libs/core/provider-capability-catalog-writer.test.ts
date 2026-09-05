import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = new Map<string, string>();
const SCHEMA_PATH = '/repo/knowledge/product/schemas/provider-capabilities.schema.json';

const SCHEMA = {
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
};

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })),
}));

vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    rootResolve: (p: string) => `/repo/${p}`,
    rootDir: () => '/repo',
    shared: (p = '') => `/repo/active/shared/${p}`,
    knowledge: (p = '') => `/repo/knowledge/${p}`,
    resolve: (p: string) => p,
  },
}));

vi.mock('./secure-io.js', () => ({
  assertSafeRepositoryPath: (p: string) => p,
  safeExistsSync: (p: string) => files.has(p),
  safeLstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
  safeReadFile: (p: string) => {
    if (!files.has(p)) throw new Error('ENOENT');
    return files.get(p)!;
  },
  safeWriteFile: (p: string, data: string) => {
    files.set(p, data);
  },
  safeMkdir: () => undefined,
  safeUnlinkSync: (p: string) => {
    files.delete(p);
  },
}));

vi.mock('./foundation/json.js', () => ({
  readJson: (filePath: string) => {
    if (filePath === SCHEMA_PATH) return SCHEMA;
    const raw = files.get(filePath);
    if (raw === undefined) throw new Error('ENOENT');
    return JSON.parse(raw);
  },
}));

vi.mock('./foundation/io.js', () => ({
  getFoundationIo: () => ({
    loadJson: (filePath: string) => {
      const raw = files.get(filePath);
      if (raw === undefined) throw new Error('ENOENT');
      return JSON.parse(raw);
    },
    loadJsonIfPresent: () => null,
    appendFile: () => undefined,
    exists: (filePath: string) => files.has(filePath),
    readFile: (filePath: string) => {
      const raw = files.get(filePath);
      if (raw === undefined) throw new Error('ENOENT');
      return raw;
    },
    stat: (filePath: string) => ({ mtimeMs: 0, size: files.get(filePath)?.length || 0 }),
    writeFile: (filePath: string, content: string) => files.set(filePath, content),
  }),
  registerFoundationIo: vi.fn(),
}));

const CATALOG = '/repo/knowledge/product/orchestration/provider-capabilities.json';

describe('mergeProbedCapabilitiesIntoCatalog (probe -> knowledge loop)', () => {
  beforeEach(async () => {
    files.clear();
    const { clearProviderDiscoveryCache } = await import('./provider-discovery.js');
    clearProviderDiscoveryCache();
  });

  it('creates the catalog when none exists and stamps provenance', async () => {
    const { mergeProbedCapabilitiesIntoCatalog } = await import('./provider-discovery.js');
    const catalog = mergeProbedCapabilitiesIntoCatalog(
      { agy: { models: ['agy'], capabilities: ['code'], modelCapabilities: { agy: ['code'] } } },
      { updatedBy: 'test', timestamp: '2026-05-29T00:00:00Z' }
    );
    expect(catalog.providers.agy?.capabilities).toEqual(['code']);
    expect(catalog.provenance).toMatchObject({ source: 'probe', updated_by: 'test' });
    expect(files.has(CATALOG)).toBe(true);
  });

  it('union-merges without destroying manually-curated capabilities', async () => {
    files.set(
      CATALOG,
      JSON.stringify({
        version: '1.0',
        providers: {
          claude: {
            models: ['opus'],
            capabilities: ['reasoning', 'managed_workflow'],
            modelCapabilities: { opus: ['reasoning', 'managed_workflow'] },
          },
        },
      })
    );

    const { mergeProbedCapabilitiesIntoCatalog } = await import('./provider-discovery.js');
    const catalog = mergeProbedCapabilitiesIntoCatalog(
      {
        claude: {
          models: ['sonnet'],
          capabilities: ['code'],
          modelCapabilities: { opus: ['deep_reasoning'] },
        },
      },
      { timestamp: '2026-05-29T00:00:00Z' }
    );

    // manual + probed are unioned, nothing dropped
    expect(catalog.providers.claude?.models.sort()).toEqual(['opus', 'sonnet']);
    expect(catalog.providers.claude?.capabilities).toEqual(
      expect.arrayContaining(['reasoning', 'managed_workflow', 'code'])
    );
    expect(catalog.providers.claude?.modelCapabilities.opus).toEqual(
      expect.arrayContaining(['reasoning', 'managed_workflow', 'deep_reasoning'])
    );
  });

  it('replace mode overwrites a provider entry', async () => {
    files.set(
      CATALOG,
      JSON.stringify({
        version: '1.0',
        providers: { codex: { models: ['old'], capabilities: ['stale'], modelCapabilities: {} } },
      })
    );
    const { mergeProbedCapabilitiesIntoCatalog } = await import('./provider-discovery.js');
    const catalog = mergeProbedCapabilitiesIntoCatalog(
      {
        codex: {
          models: ['codex'],
          capabilities: ['code'],
          modelCapabilities: { codex: ['code'] },
        },
      },
      { mode: 'replace', timestamp: '2026-05-29T00:00:00Z' }
    );
    expect(catalog.providers.codex?.models).toEqual(['codex']);
    expect(catalog.providers.codex?.capabilities).toEqual(['code']);
  });

  it('rejects malformed probe output before writing the catalog', async () => {
    const { mergeProbedCapabilitiesIntoCatalog } = await import('./provider-discovery.js');
    expect(() =>
      mergeProbedCapabilitiesIntoCatalog({
        agy: {
          models: 'not-an-array' as unknown as string[],
          capabilities: ['code'],
          modelCapabilities: {},
        },
      })
    ).toThrow(/Invalid catalog/u);
    expect(files.has(CATALOG)).toBe(false);
  });

  it('makes merged capabilities visible to discovery', async () => {
    const { spawnSync } = await import('node:child_process');
    (spawnSync as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'claude')
        return { status: 0, stdout: '/bin/claude', stderr: '' };
      if (cmd === 'claude' && args[0] === '--version')
        return { status: 0, stdout: 'claude 1.0', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });

    const { mergeProbedCapabilitiesIntoCatalog, discoverProviders } =
      await import('./provider-discovery.js');
    mergeProbedCapabilitiesIntoCatalog(
      {
        claude: {
          models: ['opus'],
          capabilities: ['new_skill'],
          modelCapabilities: { opus: ['new_skill'] },
        },
      },
      { timestamp: '2026-05-29T00:00:00Z' }
    );
    const claude = discoverProviders(true).find((p) => p.provider === 'claude');
    expect(claude?.capabilities).toContain('new_skill');
  });
});
