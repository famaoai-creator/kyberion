import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderInfo } from './provider-discovery.js';
// provider-config is a fail-closed governed catalog (main 6bbc36905): the
// virtual fs below must serve the real artifact and its schema.
import providerConfig from '../../knowledge/product/governance/provider-config.json';
import providerConfigSchema from '../../knowledge/product/schemas/provider-config.schema.json';

const recordMock = vi.fn();
const files = new Map<string, string>();
const nonRegularPaths = new Set<string>();

vi.mock('./audit-chain.js', () => ({ auditChain: { record: recordMock } }));

vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    rootResolve: (p: string) => `/repo/${p}`,
    rootDir: () => '/repo',
    knowledge: (p = '') => `/repo/knowledge/${p}`,
    shared: (p = '') => `/repo/active/shared/${p}`,
    resolve: (p: string) => p,
  },
  rootDir: () => '/repo',
  rootResolve: (p: string) => `/repo/${p}`,
  active: (p = '') => `/repo/active/${p}`,
  knowledge: (p = '') => `/repo/knowledge/${p}`,
  resolve: (p: string) => p,
  findMissionPath: () => null,
}));

vi.mock('./secure-io.js', () => ({
  assertSafeRepositoryPath: (p: string) => {
    const resolved = path.resolve(p);
    if (resolved !== '/repo' && !resolved.startsWith('/repo/')) {
      throw new Error(`[RESOURCE_PATH_SCOPE] ${p}`);
    }
    return resolved;
  },
  safeExistsSync: (p: string) => files.has(p),
  safeLstat: (p: string) => ({ isFile: () => files.has(p) && !nonRegularPaths.has(p) }),
  safeReadFile: (p: string) => {
    if (!files.has(p)) throw new Error('ENOENT');
    return files.get(p)!;
  },
  loadJson: <T>(p: string) => JSON.parse(files.get(p) || '{}') as T,
  loadJsonIfPresent: <T>(p: string) => {
    const value = files.get(p);
    return value === undefined ? null : (JSON.parse(value) as T);
  },
  safeWriteFile: (p: string, data: string) => {
    files.set(p, data);
  },
  safeMkdir: () => undefined,
  safeRmSync: (p: string) => {
    files.delete(p);
  },
  safeUnlinkSync: (p: string) => {
    files.delete(p);
  },
  safeAppendFileSync: () => undefined,
}));

vi.mock('./foundation/io.js', () => ({
  getFoundationIo: () => ({
    loadJson: <T>(p: string): T => JSON.parse(files.get(p) || '{}') as T,
    loadJsonIfPresent: <T>(p: string): T | null => {
      const value = files.get(p);
      return value === undefined ? null : (JSON.parse(value) as T);
    },
    appendFile: () => undefined,
    exists: (p: string) => files.has(p),
    readFile: (p: string) => files.get(p) || '',
    stat: () => ({ mtimeMs: 1, size: 1 }),
    writeFile: (p: string, data: string) => files.set(p, data),
  }),
  registerFoundationIo: vi.fn(),
}));

function provider(
  providerId: string,
  models: string[],
  modelCapabilities: Record<string, string[]>
): ProviderInfo {
  return {
    provider: providerId,
    installed: true,
    version: 'test',
    protocol: 'acp',
    models,
    capabilities: Array.from(new Set(Object.values(modelCapabilities).flat())),
    modelCapabilities,
    healthy: true,
  };
}

const claude = provider('claude', ['opus', 'sonnet'], {
  opus: ['reasoning', 'code', 'deep_reasoning', 'managed_workflow', 'can_fanout'],
  sonnet: ['reasoning', 'code', 'managed_workflow'],
});
const codex = provider('codex', ['codex'], { codex: ['code', 'patch', 'terminal'] });
const gemini = provider('gemini', ['gemini-2.5-pro'], {
  'gemini-2.5-pro': ['reasoning', 'analysis'],
});
const FLEET = [claude, codex, gemini];

describe('capability-broker', () => {
  beforeEach(async () => {
    files.clear();
    nonRegularPaths.clear();
    files.set(
      '/repo/knowledge/product/schemas/provider-pins.schema.json',
      JSON.stringify({
        type: 'object',
        additionalProperties: false,
        properties: {
          version: { type: 'string', minLength: 1 },
          missionId: { type: 'string', minLength: 1 },
          pins: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              additionalProperties: false,
              properties: {
                provider: { type: 'string', minLength: 1 },
                modelId: { type: 'string', minLength: 1 },
                instance: { type: ['string', 'null'], minLength: 1 },
                orchestration: { enum: ['leaf', 'managed_workflow'] },
                pinnedAt: { type: 'string', format: 'date-time' },
                by: { type: 'string', minLength: 1 },
              },
              required: ['provider', 'modelId', 'instance', 'orchestration', 'pinnedAt', 'by'],
            },
          },
        },
        required: ['version', 'pins'],
      })
    );
    files.set(
      '/repo/knowledge/product/governance/provider-config.json',
      JSON.stringify(providerConfig)
    );
    files.set(
      '/repo/knowledge/product/schemas/provider-config.schema.json',
      JSON.stringify(providerConfigSchema)
    );
    recordMock.mockClear();
    delete process.env.MISSION_ID;
    const { clearProviderHealth } = await import('./provider-health-registry.js');
    clearProviderHealth();
  });

  it('resolves fresh, records the decision, and echoes the orchestration tier', async () => {
    const { resolveProviderDecision } = await import('./capability-broker.js');
    const decision = resolveProviderDecision(
      { requiredCapabilities: ['code', 'patch', 'terminal'], decisionKey: 'role-impl' },
      FLEET
    );
    expect(decision.provider).toBe('codex');
    expect(decision.pinned).toBe(false);
    expect(decision.orchestration).toBe('leaf');
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock.mock.calls[0][0]).toMatchObject({
      action: 'provider_selection',
      metadata: { provider: 'codex', strategy: 'best-match', decisionKey: 'role-impl' },
    });
  });

  it('routes a managed_workflow task to a provider that can run a recorded fan-out', async () => {
    const { resolveProviderDecision } = await import('./capability-broker.js');
    const decision = resolveProviderDecision(
      { requiredCapabilities: ['code'], orchestration: 'managed_workflow' },
      FLEET
    );
    expect(decision.provider).toBe('claude');
    expect(decision.orchestration).toBe('managed_workflow');
    expect(decision.requiredCapabilities).toContain('managed_workflow');
  });

  it('reuses a pinned decision regardless of what fresh resolution would pick', async () => {
    const { resolveProviderDecision, pinProviderDecision, loadPinnedDecision } =
      await import('./capability-broker.js');

    const first = resolveProviderDecision(
      { requiredCapabilities: ['code', 'patch', 'terminal'], decisionKey: 'role-x', record: false },
      FLEET
    );
    expect(first.provider).toBe('codex');
    pinProviderDecision('role-x', first);
    expect(loadPinnedDecision('role-x')?.provider).toBe('codex');

    // Different requirements that would normally pick claude — pin must win.
    const reused = resolveProviderDecision(
      { requiredCapabilities: ['deep_reasoning'], decisionKey: 'role-x', record: false },
      FLEET
    );
    expect(reused.provider).toBe('codex');
    expect(reused.pinned).toBe(true);
    expect(reused.rationale).toMatch(/pinned/);
  });

  it('falls through to fresh resolution when a pin is stale (provider gone)', async () => {
    const { resolveProviderDecision, pinProviderDecision } = await import('./capability-broker.js');
    // Pin a provider that is NOT in the fleet.
    pinProviderDecision('role-y', {
      provider: 'agy',
      modelId: 'agy',
      instance: null,
      strategy: 'preferred',
      orchestration: 'leaf',
      availableProviders: [],
      requiredCapabilities: [],
      unmetCapabilities: [],
      rationale: 'stale',
      pinned: true,
      decisionKey: 'role-y',
    });

    const decision = resolveProviderDecision(
      { requiredCapabilities: ['code', 'patch', 'terminal'], decisionKey: 'role-y', record: false },
      FLEET
    );
    expect(decision.provider).toBe('codex');
    expect(decision.pinned).toBe(false);
  });

  it('rejects a mission-derived pin path that escapes the repository', async () => {
    process.env.MISSION_ID = '../../../../outside';
    const { pinProviderDecision } = await import('./capability-broker.js');

    expect(() =>
      pinProviderDecision('role-escape', {
        provider: 'codex',
        modelId: 'codex',
        instance: null,
        strategy: 'preferred',
        orchestration: 'leaf',
        availableProviders: [],
        requiredCapabilities: [],
        unmetCapabilities: [],
        rationale: 'test',
        pinned: false,
        decisionKey: 'role-escape',
      })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('fails closed for schema-invalid and non-regular pin files', async () => {
    process.env.MISSION_ID = 'MISSION-1';
    const { loadPinnedDecision } = await import('./capability-broker.js');
    const pinPath = '/repo/active/shared/runtime/provider-pins/MISSION-1.json';
    files.set(pinPath, JSON.stringify({ version: '1.0', pins: { role: 'invalid' } }));
    expect(loadPinnedDecision('role')).toBeNull();

    files.set(pinPath, JSON.stringify({ version: '1.0', pins: {} }));
    nonRegularPaths.add(pinPath);
    expect(loadPinnedDecision('role')).toBeNull();
  });
});
