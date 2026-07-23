import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderInfo } from './provider-discovery.js';

const recordMock = vi.fn();
const files = new Map<string, string>();

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
  safeExistsSync: (p: string) => files.has(p),
  safeReadFile: (p: string) => {
    if (!files.has(p)) throw new Error('ENOENT');
    return files.get(p)!;
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
});
