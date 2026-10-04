import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnOptions } from './agent-lifecycle.js';

const mocks = vi.hoisted(() => ({
  getManifest: vi.fn(),
  prerequisites: vi.fn(),
  trust: vi.fn(),
  createAdapter: vi.fn(),
  identity: vi.fn(),
  bind: vi.fn(),
  release: vi.fn(),
}));
vi.mock('./agent-manifest.js', async () => ({
  ...(await vi.importActual<typeof import('./agent-manifest.js')>('./agent-manifest.js')),
  getAgentManifest: mocks.getManifest,
  validateRequirements: mocks.prerequisites,
}));
vi.mock('./agent-registry.js', async () => ({
  ...(await vi.importActual<typeof import('./agent-registry.js')>('./agent-registry.js')),
  resolveAgentTrustScore: mocks.trust,
}));
vi.mock('./agent-exec-adapter-bridge.js', async () => ({
  ...(await vi.importActual<typeof import('./agent-exec-adapter-bridge.js')>(
    './agent-exec-adapter-bridge.js'
  )),
  hasAgentExecAdapter: async () => true,
  createAgentExecAdapter: mocks.createAdapter,
}));
vi.mock('./agent-identity.js', async () => ({
  ...(await vi.importActual<typeof import('./agent-identity.js')>('./agent-identity.js')),
  ensureAgentIdentityBestEffort: mocks.identity,
  bindAgentRuntimeInstanceBestEffort: mocks.bind,
  releaseAgentRuntimeInstanceBestEffort: mocks.release,
}));

import { agentLifecycle } from './agent-lifecycle.js';
import { agentRegistry } from './agent-registry.js';

const base = 'presence-surface-agent';
const ownerId = base + '--conversation-' + 'a'.repeat(64);
const ids = new Set<string>();
let counter = 0;
function options(overrides: Partial<SpawnOptions> = {}): SpawnOptions {
  counter += 1;
  const value = {
    agentId: ownerId + '--turn-00000000-0000-4000-8000-' + counter.toString(16).padStart(12, '0'),
    manifestAgentId: base,
    provider: 'claude',
    modelId: 'base-model',
    runtimeOwnerId: ownerId,
    runtimeOwnerType: 'surface',
    runtimeMetadata: {
      lease_kind: 'surface-conversation-turn',
      surface_agent_id: base,
      skip_provider_resolution: true,
    },
    scope: { tier: 'confidential' as const, tenant_slug: 'acme', viewer_principal: 'viewer-a' },
    ...overrides,
  };
  ids.add(value.agentId!);
  return value;
}
const manifest = {
  agentId: base,
  systemPrompt: 'base authoritative policy',
  capabilities: ['conversation'],
  allowedActuators: ['approved-reader'],
  deniedActuators: ['blocked-writer'],
  trustRequired: 700,
  requires: { env: ['REQUIRED_BASE_SETTING'] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getManifest.mockReturnValue(manifest);
  mocks.prerequisites.mockReturnValue({ ok: true, reasons: [] });
  mocks.trust.mockReturnValue(800);
  mocks.identity.mockImplementation(({ slug }) => ({
    nhi_id: 'kyberion://agent/test/' + slug,
    recorded: true,
  }));
  mocks.createAdapter.mockResolvedValue({
    boot: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    ask: vi.fn(async () => ({ text: 'done' })),
  });
});
afterEach(async () => {
  for (const id of ids) await agentLifecycle.shutdown(id);
  ids.clear();
});

describe('surface runtime instances preserve their base manifest policy', () => {
  it('keeps prerequisite validation, actuator allow/deny and authoritative prompt/capabilities', async () => {
    const value = options({
      systemPrompt: 'caller substitution',
      capabilities: ['everything'],
      trustRequired: 0,
    });
    const handle = await agentLifecycle.spawn(value);
    expect(mocks.getManifest).toHaveBeenCalledWith(base);
    expect(mocks.prerequisites).toHaveBeenCalledWith(manifest);
    expect(mocks.trust).toHaveBeenCalledWith(base, undefined);
    expect(mocks.createAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: manifest.systemPrompt,
        allowedActuators: ['approved-reader'],
        deniedActuators: ['blocked-writer'],
      })
    );
    expect(handle.getRecord()).toMatchObject({
      capabilities: ['conversation'],
      scope: expect.objectContaining(value.scope!),
      metadata: { manifest_agent_id: base },
    });
  });

  it('does not bypass base prerequisites or lower its trust floor', async () => {
    mocks.prerequisites.mockReturnValueOnce({ ok: false, reasons: ['base prerequisite missing'] });
    const failedPrerequisite = options();
    await expect(agentLifecycle.spawn(failedPrerequisite)).rejects.toThrow(
      'base prerequisite missing'
    );
    await agentLifecycle.shutdown(failedPrerequisite.agentId!);
    mocks.trust.mockReturnValue(600);
    await expect(agentLifecycle.spawn(options({ trustRequired: 0 }))).rejects.toThrow(
      /below required 700/
    );
    expect(mocks.createAdapter).not.toHaveBeenCalled();
    expect(mocks.identity).not.toHaveBeenCalled();
  });

  it('binds fresh runtime instances to one base NHI rather than minting conversation identities', async () => {
    const first = options();
    const second = options();
    await agentLifecycle.spawn(first);
    await agentLifecycle.shutdown(first.agentId!);
    await agentLifecycle.spawn(second);
    expect(mocks.identity).toHaveBeenCalledTimes(2);
    for (const [request] of mocks.identity.mock.calls) expect(request.slug).toBe(base);
    expect(mocks.bind.mock.calls.map(([request]) => request.instanceId)).toEqual([
      first.agentId,
      second.agentId,
    ]);
    expect(agentRegistry.getRuntimeIdentity(second.agentId!)).toBe('kyberion://agent/test/' + base);
    await agentLifecycle.shutdown(first.agentId!);
    expect(mocks.release).toHaveBeenCalledWith(
      'kyberion://agent/test/' + base,
      first.agentId,
      'shutdown'
    );
  });

  it('rejects missing base manifests, arbitrary alias identities, and missing alias transport', async () => {
    mocks.getManifest.mockReturnValueOnce(null);
    await expect(agentLifecycle.spawn(options())).rejects.toThrow(/ALIAS_MISSING/);
    await expect(
      agentLifecycle.spawn(options({ agentId: 'another-established-agent' }))
    ).rejects.toThrow(/ALIAS_INVALID/);
    await expect(
      agentLifecycle.spawn(options({ runtimeOwnerId: 'unrelated-owner' }))
    ).rejects.toThrow(/ALIAS_INVALID/);
    await expect(agentLifecycle.spawn(options({ manifestAgentId: undefined }))).rejects.toThrow(
      /ALIAS_REQUIRED/
    );
    await expect(agentLifecycle.spawn(options({ scope: { tier: 'public' } }))).rejects.toThrow(
      /ALIAS_INVALID/
    );
    expect(mocks.createAdapter).not.toHaveBeenCalled();
  });

  it('does not acknowledge a stop until a deferred spawn has settled and been cleaned', async () => {
    let release!: () => void;
    const boot = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const shutdown = vi.fn(async () => undefined);
    mocks.createAdapter.mockResolvedValue({ boot, shutdown });
    const value = options();
    const spawned = agentLifecycle.spawn(value);
    await vi.waitFor(() => expect(boot).toHaveBeenCalledOnce());
    let acknowledged = false;
    const stopped = agentLifecycle.shutdown(value.agentId!).then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(shutdown).not.toHaveBeenCalled();
    await expect(agentLifecycle.spawn(value)).rejects.toThrow(/STOPPING/);
    release();
    await spawned;
    await stopped;
    expect(shutdown).toHaveBeenCalledOnce();
    expect(agentLifecycle.getHandle(value.agentId!)).toBeUndefined();
    expect(agentRegistry.get(value.agentId!)).toBeUndefined();
  });

  it('retains cleanup ownership when adapter boot fails', async () => {
    const shutdown = vi.fn(async () => undefined);
    mocks.createAdapter.mockResolvedValue({
      boot: vi.fn(async () => {
        throw new Error('boot failed');
      }),
      shutdown,
    });
    const value = options();
    await expect(agentLifecycle.spawn(value)).rejects.toThrow('boot failed');
    await agentLifecycle.shutdown(value.agentId!);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(agentRegistry.get(value.agentId!)).toBeUndefined();
  });

  it('caps canonical scoped reservations while boots are pending and releases them only after stop', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.createAdapter.mockResolvedValue({
      boot: async () => gate,
      shutdown: async () => undefined,
    });
    const values = Array.from({ length: 8 }, (_, index) => {
      const owner = base + '--conversation-' + index.toString(16).repeat(64);
      return options({
        runtimeOwnerId: owner,
        agentId: owner + '--turn-00000000-0000-4000-8000-000000000001',
      });
    });
    const pending = values.map((value) => agentLifecycle.spawn(value));
    const owner = base + '--conversation-' + 'f'.repeat(64);
    const ninth = options({
      runtimeOwnerId: owner,
      agentId: owner + '--turn-00000000-0000-4000-8000-000000000001',
    });
    await expect(agentLifecycle.spawn(ninth)).rejects.toThrow(/CAPACITY/);
    await expect(
      agentLifecycle.spawn(
        options({
          runtimeOwnerId: values[0].runtimeOwnerId,
          agentId: values[0].agentId!.replace(/1$/, '2'),
        })
      )
    ).rejects.toThrow(/BUSY/);
    release();
    await Promise.all(pending);
    for (const value of values) await agentLifecycle.shutdown(value.agentId!);
    await expect(agentLifecycle.spawn(ninth)).resolves.toMatchObject({ agentId: ninth.agentId });
  });

  it('keeps canonical reservations when stop fails and permits an explicit stop retry', async () => {
    const shutdown = vi
      .fn()
      .mockRejectedValueOnce(new Error('stop failed'))
      .mockResolvedValue(undefined);
    mocks.createAdapter.mockResolvedValue({ boot: async () => undefined, shutdown });
    const value = options();
    await agentLifecycle.spawn(value);
    await expect(agentLifecycle.shutdown(value.agentId!)).rejects.toThrow('stop failed');
    await expect(agentLifecycle.spawn(options())).rejects.toThrow(/BUSY/);
    await agentLifecycle.shutdown(value.agentId!);
    expect(shutdown).toHaveBeenCalledTimes(2);
  });

  it('preserves ordinary manifest lookup and identity for legacy runtimes', async () => {
    const value = options({
      agentId: 'legacy-agent',
      manifestAgentId: undefined,
      runtimeOwnerId: 'legacy-agent',
      systemPrompt: 'legacy supplied prompt',
      capabilities: ['legacy-capability'],
    });
    const handle = await agentLifecycle.spawn(value);
    expect(mocks.getManifest).toHaveBeenCalledWith('legacy-agent');
    expect(mocks.createAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: 'legacy supplied prompt' })
    );
    expect(handle.getRecord()?.capabilities).toEqual(['legacy-capability']);
    expect(mocks.identity).toHaveBeenCalledWith(expect.objectContaining({ slug: 'legacy-agent' }));
  });
});
