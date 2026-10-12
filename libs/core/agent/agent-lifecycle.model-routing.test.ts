import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentLifecycle, resolveAgentLifecycleModelId } from './agent-lifecycle.js';
import { agentRegistry, resolveAgentTrustScore } from './agent-registry.js';
import { trustEngine } from '../trust-engine.js';
import { ACPMediator } from '../mesh/acp-mediator.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from '../secure-io.js';
import { getAgentIdentity, resetAgentIdentityServiceForTests } from './agent-identity.js';
import { runtimeSupervisor } from '../tool/runtime-supervisor.js';
import * as providerDiscovery from '../provider/provider-discovery.js';
import * as providerResolution from './agent-provider-resolution.js';
import * as execAdapterBridge from './agent-exec-adapter-bridge.js';

describe('agent-lifecycle model routing', () => {
  it('routes task model routing environment reads through the governed accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/agent/agent-lifecycle.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });

  it('does not enter explicit selection parsing for absent legacy metadata', () => {
    const parse = vi
      .spyOn(providerResolution, 'parseAgentRequestedSelection')
      .mockImplementation(() => {
        throw new Error('Legacy requests must not invoke the explicit selection parser');
      });
    try {
      expect(resolveAgentLifecycleModelId({ modelId: 'legacy-model' }, {})).toBe('legacy-model');
      expect(
        resolveAgentLifecycleModelId({ modelId: 'legacy-model', runtimeMetadata: {} }, {})
      ).toBe('legacy-model');
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it.each([null, 'fixed', {}, { mode: 'invalid' }])(
    'rejects explicitly malformed selection metadata %j',
    (requested_selection) => {
      expect(() =>
        resolveAgentLifecycleModelId(
          {
            modelId: 'legacy-model',
            runtimeMetadata: { requested_selection },
          },
          {}
        )
      ).toThrow(/AGENT_SELECTION_INVALID/);
    }
  );

  it('keeps the manifest model in advisory mode', () => {
    expect(
      resolveAgentLifecycleModelId(
        {
          modelId: 'openai:gpt-5.4-mini',
          runtimeMetadata: {
            task_model_hint: {
              tier: 'large',
              effort: 'high',
              model_id: 'openai:gpt-5.5',
              route_reason: 'test',
            },
          },
        },
        {
          KYBERION_TASK_MODEL_ROUTING: 'advisory',
        }
      )
    ).toBe('openai:gpt-5.4-mini');
  });

  it('prefers the task hint when routing is enforced', () => {
    expect(
      resolveAgentLifecycleModelId(
        {
          modelId: 'openai:gpt-5.4-mini',
          runtimeMetadata: {
            task_model_hint: {
              tier: 'large',
              effort: 'high',
              model_id: 'openai:gpt-5.5',
              route_reason: 'test',
            },
          },
        },
        {
          KYBERION_TASK_MODEL_ROUTING: 'enforce',
        }
      )
    ).toBe('openai:gpt-5.5');
  });

  it('rejects enforced task model replacement of an explicit fixed model', () => {
    expect(() =>
      resolveAgentLifecycleModelId(
        {
          modelId: 'exact',
          runtimeMetadata: {
            requested_selection: { mode: 'fixed', model_id: 'exact' },
            task_model_hint: {
              tier: 'large',
              effort: 'high',
              model_id: 'other',
              route_reason: 'test',
            },
          },
        },
        { KYBERION_TASK_MODEL_ROUTING: 'enforce' }
      )
    ).toThrow(/AGENT_SELECTION_ROUTING_CONFLICT/);
  });

  it('preserves fixed models in advisory mode and accepts matching enforced hints', () => {
    const options = {
      modelId: 'other',
      runtimeMetadata: {
        requested_selection: { mode: 'fixed', model_id: 'exact' },
        task_model_hint: { tier: 'large', effort: 'high', model_id: 'exact', route_reason: 'test' },
      },
    };
    expect(resolveAgentLifecycleModelId(options, { KYBERION_TASK_MODEL_ROUTING: 'advisory' })).toBe(
      'exact'
    );
    expect(resolveAgentLifecycleModelId(options, { KYBERION_TASK_MODEL_ROUTING: 'enforce' })).toBe(
      'exact'
    );
  });

  it('uses the trust engine score instead of a fixed bootstrap value', () => {
    const agentId = `agent-${Date.now()}-trust`;
    trustEngine.initialize(agentId, 742);

    expect(resolveAgentTrustScore(agentId)).toBe(742);
    expect(resolveAgentTrustScore(`${agentId}-missing`)).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// NI-01: spawn/shutdown wiring against the durable AgentIdentity ledger.
// Hermetic: the identity journal is repointed at a per-test tmp path and the
// ACP mediator is fully mocked (no process is ever spawned).
// ---------------------------------------------------------------------------

describe('agent-lifecycle NI-01 identity wiring', () => {
  const TMP_DIR = `active/shared/tmp/agent-lifecycle-ni01-${process.pid}`;
  let counter = 0;
  let previousMissionRole: string | undefined;

  beforeEach(() => {
    counter += 1;
    resetAgentIdentityServiceForTests(`${TMP_DIR}/agent-identities-${counter}.jsonl`);
    previousMissionRole = process.env.MISSION_ROLE;
    process.env.MISSION_ROLE = 'mission_controller';
    vi.spyOn(ACPMediator.prototype, 'boot').mockResolvedValue();
    vi.spyOn(ACPMediator.prototype, 'shutdown').mockResolvedValue();
  });

  afterEach(() => {
    if (previousMissionRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = previousMissionRole;
    vi.restoreAllMocks();
    resetAgentIdentityServiceForTests();
  });

  afterAll(() => {
    const dir = pathResolver.rootResolve(TMP_DIR);
    if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
  });

  it('spawn issues a durable identity, binds the instance, and stamps the registry; shutdown releases the instance but keeps the identity', async () => {
    const agentId = 'ni01-wired-agent';
    await agentLifecycle.spawn({
      agentId,
      provider: 'agy',
      modelId: 'Gemini 3.6 Flash (Medium)',
      missionId: 'MSN-NI01-WIRE-001',
      runtimeMetadata: { skip_provider_resolution: true },
    });

    const nhiId = agentRegistry.getRuntimeIdentity(agentId);
    expect(nhiId).toMatch(/^kyberion:\/\/agent\/[a-z][a-z0-9-]*\/ni01-wired-agent$/);

    const identity = getAgentIdentity(nhiId!);
    expect(identity).not.toBeNull();
    expect(identity?.lifecycle_status).toBe('active');
    expect(identity?.affiliation.mission_id).toBe('MSN-NI01-WIRE-001');
    expect(identity?.runtime_instances?.map((entry) => entry.instance_id)).toEqual([agentId]);

    await agentLifecycle.shutdown(agentId);

    // Instance binding released; the durable identity survives until retired.
    const afterShutdown = getAgentIdentity(nhiId!);
    expect(afterShutdown?.lifecycle_status).toBe('active');
    expect(afterShutdown?.runtime_instances).toBeUndefined();
    expect(agentRegistry.get(agentId)).toBeUndefined();
  });

  it('spawn still succeeds when the identity ledger refuses the write (non-allowlisted context)', async () => {
    delete process.env.MISSION_ROLE; // resolveRole falls back to a non-allowlisted proc name
    const agentId = 'ni01-ungoverned-agent';
    const handle = await agentLifecycle.spawn({
      agentId,
      provider: 'agy',
      modelId: 'Gemini 3.6 Flash (Medium)',
      runtimeMetadata: { skip_provider_resolution: true },
    });
    expect(handle.agentId).toBe(agentId);

    // The canonical name is still stamped (deterministic derivation) but no
    // ledger record was created — NI-02 warn-mode surfaces such names later.
    const nhiId = agentRegistry.getRuntimeIdentity(agentId);
    expect(nhiId).toMatch(/ni01-ungoverned-agent$/);
    expect(getAgentIdentity(nhiId!)).toBeNull();

    await agentLifecycle.shutdown(agentId);
  });

  it('registers the propagated supervisor owner at runtime creation', async () => {
    const agentId = 'ni01-runtime-owner-agent';
    await agentLifecycle.spawn({
      agentId,
      provider: 'agy',
      modelId: 'Gemini 3.6 Flash (Medium)',
      missionId: 'MSN-NI01-RUNTIME-OWNER',
      runtimeOwnerId: 'agent-runtime-supervisor:request-1',
      runtimeOwnerType: 'agent-runtime-supervisor',
      runtimeMetadata: { skip_provider_resolution: true },
    });

    expect(runtimeSupervisor.get(agentId)).toMatchObject({
      ownerId: 'agent-runtime-supervisor:request-1',
      ownerType: 'agent-runtime-supervisor',
    });
    await agentLifecycle.shutdown(agentId);
  });
  it('launches, asks and restarts a fake adapter with the exact fixed model', async () => {
    const agentId = 'fixed-exact-adapter-agent';
    vi.spyOn(providerDiscovery, 'discoverProviders').mockReturnValue([
      {
        provider: 'codex',
        installed: true,
        healthy: true,
        version: 'test',
        protocol: 'exec',
        models: ['exact', 'alternative'],
        capabilities: ['terminal'],
        modelCapabilities: { exact: ['code'], alternative: ['code'] },
      },
    ]);
    const boot = vi.fn(async () => undefined);
    const ask = vi.fn(async () => ({ text: 'exact response', stopReason: 'completed' }));
    const shutdown = vi.fn(async () => undefined);
    vi.spyOn(execAdapterBridge, 'hasAgentExecAdapter').mockResolvedValue(true);
    const create = vi
      .spyOn(execAdapterBridge, 'createAgentExecAdapter')
      .mockResolvedValue({ boot, ask, shutdown });
    vi.stubEnv('KYBERION_TASK_MODEL_ROUTING', 'advisory');
    try {
      const firstHandle = await agentLifecycle.spawn({
        agentId,
        provider: 'codex',
        modelId: 'exact',
        runtimeMetadata: {
          requested_selection: { mode: 'preferred', provider: 'codex', model_id: 'exact' },
          required_capabilities: ['code', 'terminal'],
        },
      });
      agentRegistry.updateStatus(agentId, 'busy');
      const handle = await agentLifecycle.spawn({
        agentId,
        provider: 'codex',
        modelId: 'alternative',
        runtimeMetadata: {
          requested_selection: {
            mode: 'fixed',
            agent_id: agentId,
            provider: 'codex',
            model_id: 'exact',
          },
          required_capabilities: ['code', 'terminal'],
          skip_provider_resolution: true,
          task_model_hint: {
            tier: 'large',
            effort: 'high',
            model_id: 'alternative',
            route_reason: 'test',
          },
        },
      });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'codex', modelId: 'exact' })
      );
      expect(boot).toHaveBeenCalledOnce();
      expect(handle).toBe(firstHandle);
      expect(shutdown).not.toHaveBeenCalled();
      expect(handle.getRecord()?.metadata?.requested_selection).toMatchObject({
        mode: 'fixed',
        model_id: 'exact',
      });
      await expect(
        agentLifecycle.spawn({
          agentId,
          provider: 'codex',
          modelId: 'alternative',
          runtimeMetadata: {
            requested_selection: { mode: 'fixed', provider: 'codex', model_id: 'alternative' },
            required_capabilities: ['code'],
          },
        })
      ).rejects.toThrow(/AGENT_SELECTION_RUNTIME_CONFLICT/);
      expect(shutdown).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledOnce();
      expect(await handle.ask('use the selected model')).toBe('exact response');
      expect(ask).toHaveBeenCalledWith('use the selected model');
      expect(handle.getRecord()).toMatchObject({ provider: 'codex', modelId: 'exact' });
      await agentLifecycle.restart(agentId);
      expect(create).toHaveBeenCalledTimes(2);
      expect(
        create.mock.calls.every(
          ([request]) => request.provider === 'codex' && request.modelId === 'exact'
        )
      ).toBe(true);
    } finally {
      await agentLifecycle.shutdown(agentId);
      vi.unstubAllEnvs();
    }
  });

  it('cannot bypass explicit fixed availability using skip_provider_resolution', async () => {
    vi.spyOn(providerDiscovery, 'discoverProviders').mockReturnValue([]);
    await expect(
      agentLifecycle.spawn({
        agentId: 'fixed-unavailable-agent',
        provider: 'claude',
        modelId: 'exact',
        runtimeMetadata: {
          skip_provider_resolution: true,
          requested_selection: { mode: 'fixed', provider: 'claude', model_id: 'exact' },
          required_capabilities: [],
        },
      })
    ).rejects.toThrow(/AGENT_SELECTION_PROVIDER_UNAVAILABLE/);
    expect(ACPMediator.prototype.boot).not.toHaveBeenCalled();
    expect(agentRegistry.get('fixed-unavailable-agent')).toBeUndefined();
  });

  it('keeps fixed agent identity distinct from a provider target', async () => {
    await expect(
      agentLifecycle.spawn({
        agentId: 'actual-agent',
        provider: 'codex',
        modelId: 'exact',
        runtimeMetadata: { requested_selection: { mode: 'fixed', agent_id: 'different-agent' } },
      })
    ).rejects.toThrow(/AGENT_SELECTION_IDENTITY_CONFLICT/);
    expect(ACPMediator.prototype.boot).not.toHaveBeenCalled();
  });

  it('fails closed when a tool-less runtime is requested from a provider that cannot disable tools', async () => {
    await expect(
      agentLifecycle.spawn({
        agentId: 'lockdown-agy-agent',
        provider: 'agy',
        modelId: 'Gemini 3.6 Flash (Medium)',
        toolAccess: 'none',
        runtimeMetadata: { skip_provider_resolution: true },
      })
    ).rejects.toThrow(/TOOL_LOCKDOWN_UNSUPPORTED/);
    expect(ACPMediator.prototype.boot).not.toHaveBeenCalled();
    // Refused before registration: nothing is left behind.
    expect(agentRegistry.get('lockdown-agy-agent')).toBeUndefined();
  });

  it('fails closed when a tool-less runtime is requested on the pane backend', async () => {
    await expect(
      agentLifecycle.spawn({
        agentId: 'lockdown-pane-agent',
        provider: 'claude',
        runtimeBackend: 'pane',
        toolAccess: 'none',
        runtimeMetadata: { skip_provider_resolution: true },
      })
    ).rejects.toThrow(/TOOL_LOCKDOWN_UNSUPPORTED/);
    expect(agentRegistry.get('lockdown-pane-agent')).toBeUndefined();
  });
});
