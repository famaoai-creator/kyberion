import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentLifecycle, resolveAgentLifecycleModelId } from './agent-lifecycle.js';
import { agentRegistry, resolveAgentTrustScore } from './agent-registry.js';
import { trustEngine } from './trust-engine.js';
import { ACPMediator } from './acp-mediator.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';
import { getAgentIdentity, resetAgentIdentityServiceForTests } from './agent-identity.js';
import { runtimeSupervisor } from './runtime-supervisor.js';

describe('agent-lifecycle model routing', () => {
  it('routes task model routing environment reads through the governed accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/agent-lifecycle.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });

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
});
