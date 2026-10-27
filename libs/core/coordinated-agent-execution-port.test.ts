import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentExecutionPort, AgentTaskEnvelope } from './agent/agent-execution-port.js';
import { logger } from './core.js';
import { registerSecretResolver, resetSecretResolver } from './secret/secret-resolver.js';
import { resolveTaskCredential } from './foundation/credential-binding.js';
import { currentActor, type ActorContext } from './actor-context.js';
import {
  clearWorkCoordinationStore,
  claimWorkItem,
  createWorkItem,
  getWorkItem,
  listActiveWorkLeases,
  releaseWorkItem,
  setWorkCoordinationNamespace,
  updateWorkItem,
  expireWorkItemLeases,
} from './workforce/work-coordination.js';
import {
  CoordinatedAgentExecutionPort,
  delegateCoordinatedCliSubagentTask,
  delegateCoordinatedAgentTask,
} from './coordinated-agent-execution-port.js';
import {
  currentScopeEnvelope,
  mintScopeEnvelope,
  resetScopeEnvelopeState,
  withScopeEnvelope,
  type ScopeEnvelope,
} from './scope-envelope.js';

describe('CoordinatedAgentExecutionPort', () => {
  it.each(['throw', 'receipt'] as const)(
    'retains uncertain transport ownership across lease expiry: %s',
    async (mode) => {
      const item = createWorkItem({
        itemId: 'WI-UNCERTAIN',
        title: 'Uncertain remote effect',
        description: 'Do not replay a lost remote reply',
        status: 'ready',
        metadata: { target: 'service:synthetic-effect' },
      });
      const delegate = vi.fn(async (request: AgentTaskEnvelope) => {
        if (mode === 'throw') throw new Error('supervisor_response_closed');
        return {
          execution_kind: 'agent_delegation' as const,
          task_id: request.task_id,
          agent_id: 'agent-1',
          status: 'failed' as const,
          error: 'supervisor_request_timeout',
        };
      });
      const request = {
        work_item_id: item.item_id,
        task_id: 'task-uncertain',
        mission_id: 'MSN-UNCERTAIN',
        security_scope: {
          mission_id: 'MSN-UNCERTAIN',
          read_tiers: ['public' as const],
          write_tier: 'public' as const,
          purpose: 'transport test',
        },
        instruction: 'bounded effect',
        idempotency_key: 'uncertain-1',
      };
      const port = new CoordinatedAgentExecutionPort({ delegate }, 'worker-1');
      if (mode === 'throw')
        await expect(port.delegate(request)).rejects.toThrow('supervisor_response_closed');
      else expect((await port.delegate(request)).status).toBe('failed');
      const held = getWorkItem(item.item_id)!;
      expect(held).toMatchObject({
        status: 'blocked',
        lease_id: expect.any(String),
        effect_ownership: {
          state: 'held',
          actor_id: 'worker-1',
          attempt_id: held.current_attempt_id,
          target: 'service:synthetic-effect',
        },
        metadata: { execution_outcome: 'unknown', recovery_required: true },
      });
      expect(held.metadata?.dot_id).toBeUndefined();
      expect(() =>
        updateWorkItem({ itemId: item.item_id, status: 'in_progress', metadata: {} })
      ).toThrow('held effects cannot be resumed');
      expireWorkItemLeases(new Date(Date.now() + 60 * 60_000).toISOString());
      updateWorkItem({ itemId: item.item_id, status: 'ready', metadata: {} });
      await expect(port.delegate(request)).rejects.toThrow(/ownership/);
      expect(delegate).toHaveBeenCalledTimes(1);
    }
  );

  beforeEach(() => {
    setWorkCoordinationNamespace(`coordinated-agent-execution-port-test-${process.pid}`);
    clearWorkCoordinationStore();
    resetScopeEnvelopeState();
  });

  afterEach(() => {
    resetSecretResolver();
    clearWorkCoordinationStore();
    setWorkCoordinationNamespace(null);
  });

  it('binds configured credentials only after the current claim inside the narrowed envelope', async () => {
    const item = createWorkItem({
      itemId: 'WI-CREDENTIAL-BIND',
      title: 'bound dispatch',
      description: 'credential composition fixture',
      status: 'ready',
    });
    const bindTask = vi.fn(async function (
      this: { name: string },
      input: {
        workItemId: string;
        scope: { tenant_slug?: string; mission_id?: string; task_id?: string };
      }
    ) {
      expect(this.name).toBe('trusted-test-resolver');
      expect(getWorkItem(input.workItemId)?.lease_id).toBeTruthy();
      expect(currentScopeEnvelope()?.identity.task_id).toBe('task-bind');
      return {
        tenantSlug: input.scope.tenant_slug!,
        missionId: input.scope.mission_id,
        taskId: input.scope.task_id,
        secrets: { TEST_BOUND_KEY: 'task-secret' },
      };
    });
    registerSecretResolver({ name: 'trusted-test-resolver', resolve: () => null, bindTask });
    const parent = mintScopeEnvelope({
      env: {
        KYBERION_TIER: 'confidential',
        KYBERION_TENANT: 'alpha',
        MISSION_ID: 'MSN-CREDENTIAL-BIND',
      },
      policy: { purpose: 'credential dispatch' },
    });
    const port = new CoordinatedAgentExecutionPort({
      delegate: async (request) => {
        expect(resolveTaskCredential('TEST_BOUND_KEY')).toBe('task-secret');
        return {
          execution_kind: 'agent_delegation',
          task_id: request.task_id,
          agent_id: 'agent-a',
          status: 'succeeded',
          output: 'done',
        };
      },
    });
    await withScopeEnvelope(parent, () =>
      port.delegate({
        work_item_id: item.item_id,
        task_id: 'task-bind',
        mission_id: 'MSN-CREDENTIAL-BIND',
        instruction: 'read',
        security_scope: {
          tenant_id: 'alpha',
          mission_id: 'MSN-CREDENTIAL-BIND',
          read_tiers: ['confidential'],
          write_tier: 'confidential',
          purpose: 'credential dispatch',
        },
      })
    );
    expect(bindTask).toHaveBeenCalledTimes(1);
    expect(resolveTaskCredential('TEST_BOUND_KEY')).toBeUndefined();
  });

  it('closes the claim and never delegates when the configured binder fails', async () => {
    const item = createWorkItem({
      itemId: 'WI-CREDENTIAL-FAIL',
      title: 'bound dispatch',
      description: 'credential composition fixture',
      status: 'ready',
    });
    registerSecretResolver({
      name: 'failing-test-resolver',
      resolve: () => null,
      bindTask: async () => {
        throw new Error('private secret value');
      },
    });
    const parent = mintScopeEnvelope({
      env: {
        KYBERION_TIER: 'confidential',
        KYBERION_TENANT: 'alpha',
        MISSION_ID: 'MSN-CREDENTIAL-FAIL',
      },
      policy: { purpose: 'credential dispatch' },
    });
    const delegate = vi.fn();
    await expect(
      withScopeEnvelope(parent, () =>
        new CoordinatedAgentExecutionPort({ delegate }).delegate({
          work_item_id: item.item_id,
          task_id: 'task-fail',
          mission_id: 'MSN-CREDENTIAL-FAIL',
          instruction: 'read',
          security_scope: {
            tenant_id: 'alpha',
            mission_id: 'MSN-CREDENTIAL-FAIL',
            read_tiers: ['confidential'],
            write_tier: 'confidential',
            purpose: 'credential dispatch',
          },
        })
      )
    ).rejects.toThrow('CREDENTIAL_BINDING_UNAVAILABLE');
    expect(delegate).not.toHaveBeenCalled();
    expect(getWorkItem(item.item_id)?.status).toBe('blocked');
  });

  it('claims and closes a work item around agent-runtime execution', async () => {
    clearWorkCoordinationStore();
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-001',
      title: 'coordinated task',
      description: 'run through the shared execution boundary',
      projectId: 'MSN-COORDINATED-001',
      status: 'ready',
    });
    const delegatePort: AgentExecutionPort = {
      delegate: vi.fn(async () => ({
        execution_kind: 'agent_delegation' as const,
        task_id: 'task-1',
        agent_id: 'agent-1',
        runtime_id: 'runtime-1',
        provider: 'codex-cli',
        model_id: 'gpt-5.6-luna',
        native_subagent: { threadId: 'thread-1', turnId: 'turn-1' },
        status: 'succeeded' as const,
        output: 'done',
      })),
    };
    const port = new CoordinatedAgentExecutionPort(delegatePort);

    const receipt = await port.delegate({
      work_item_id: item.item_id,
      task_id: 'task-1',
      mission_id: 'MSN-COORDINATED-001',
      agent_id: 'agent-1',
      security_scope: {
        tenant_id: 'default',
        mission_id: 'MSN-COORDINATED-001',
        read_tiers: ['public'],
        write_tier: 'public',
        purpose: 'coordinated execution test',
      },
      instruction: 'execute the task',
      idempotency_key: 'coord-1',
    });

    expect(receipt.work_item_id).toBe(item.item_id);
    expect(receipt.runtime_id).toBe('runtime-1');
    expect(receipt.provider).toBe('codex-cli');
    expect(receipt.model_id).toBe('gpt-5.6-luna');
    expect(receipt.native_subagent).toMatchObject({ threadId: 'thread-1' });
    const stored = getWorkItem(item.item_id);
    expect(stored?.attempts?.[0]?.metadata).toMatchObject({
      attempt_id: expect.any(String),
      provider: 'codex-cli',
      model_id: 'gpt-5.6-luna',
      native_subagent: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    expect(stored?.status).toBe('done');
    expect(listActiveWorkLeases()).toHaveLength(0);
    expect(delegatePort.delegate).toHaveBeenCalledTimes(1);
  });

  it('narrows the active scope envelope and exposes it inside the delegation', async () => {
    clearWorkCoordinationStore();
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-ENV-001',
      title: 'envelope narrowing task',
      description: 'child runs under a narrowed scope envelope',
      projectId: 'MSN-COORDINATED-ENV',
      status: 'ready',
    });
    let envelopeInDelegate: ScopeEnvelope | undefined;
    let actorInDelegate: ActorContext | undefined;
    const delegatePort: AgentExecutionPort = {
      delegate: vi.fn(async () => {
        envelopeInDelegate = currentScopeEnvelope();
        actorInDelegate = currentActor();
        return {
          execution_kind: 'agent_delegation' as const,
          task_id: 'task-env',
          agent_id: 'agent-1',
          status: 'succeeded' as const,
          output: 'done',
        };
      }),
    };
    const port = new CoordinatedAgentExecutionPort(
      delegatePort,
      'kyberion://agent/acme/dispatcher'
    );
    const parent = mintScopeEnvelope({
      env: {
        KYBERION_TIER: 'confidential',
        KYBERION_TENANT: 'default',
        MISSION_ID: 'MSN-COORDINATED-ENV',
      } as NodeJS.ProcessEnv,
      policy: { purpose: 'parent dispatch' },
    });

    await withScopeEnvelope(parent, () =>
      port.delegate({
        work_item_id: item.item_id,
        task_id: 'task-env',
        mission_id: 'MSN-COORDINATED-ENV',
        agent_id: 'agent-1',
        security_scope: {
          tenant_slug: 'default',
          mission_id: 'MSN-COORDINATED-ENV',
          read_tiers: ['public'],
          write_tier: 'public',
          purpose: 'narrowed delegation',
        },
        instruction: 'execute the task',
        idempotency_key: 'coord-env-1',
      })
    );

    expect(envelopeInDelegate?.mint_ref).not.toBe(parent.mint_ref);
    expect(envelopeInDelegate?.policy.read_tiers).toEqual(['public']);
    expect(envelopeInDelegate?.identity.mission_id).toBe('MSN-COORDINATED-ENV');
    expect(actorInDelegate?.actor.id).toBe('kyberion://agent/acme/dispatcher');
    expect(actorInDelegate?.scope.mission_id).toBe('MSN-COORDINATED-ENV');
    expect(actorInDelegate?.provenance).toBe('claim');
    expect(currentActor()).toBeUndefined();
    expect(currentScopeEnvelope()).toBeUndefined();
  });

  it('rejects a delegation whose scope widens the active envelope before claiming', async () => {
    clearWorkCoordinationStore();
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-ENV-002',
      title: 'widening attempt',
      description: 'must be denied before any claim',
      projectId: 'MSN-COORDINATED-ENV',
      status: 'ready',
    });
    const delegatePort: AgentExecutionPort = { delegate: vi.fn() };
    const port = new CoordinatedAgentExecutionPort(delegatePort);
    const parent = mintScopeEnvelope({
      env: {
        KYBERION_TIER: 'confidential',
        KYBERION_TENANT: 'default',
        MISSION_ID: 'MSN-COORDINATED-ENV',
      } as NodeJS.ProcessEnv,
      policy: { purpose: 'parent dispatch', read_tiers: ['public'], write_tier: 'public' },
    });

    await expect(
      withScopeEnvelope(parent, () =>
        port.delegate({
          work_item_id: item.item_id,
          task_id: 'task-env-2',
          mission_id: 'MSN-COORDINATED-ENV',
          agent_id: 'agent-1',
          security_scope: {
            tenant_slug: 'default',
            mission_id: 'MSN-COORDINATED-ENV',
            read_tiers: ['public', 'confidential'],
            write_tier: 'confidential',
            purpose: 'widening delegation',
          },
          instruction: 'execute the task',
          idempotency_key: 'coord-env-2',
        })
      )
    ).rejects.toThrow('[OP_SCOPE_DENIED]');
    expect(delegatePort.delegate).not.toHaveBeenCalled();
    expect(getWorkItem(item.item_id)?.attempts ?? []).toHaveLength(0);
  });

  describe('minting without an active envelope', () => {
    const delegateAndObserve = async (
      scope: Record<string, unknown>,
      itemId: string
    ): Promise<ScopeEnvelope | undefined> => {
      clearWorkCoordinationStore();
      createWorkItem({
        itemId,
        title: 'mint boundary',
        description: 'request scope is caller input',
        projectId: 'MSN-C',
        status: 'ready',
      });
      let seen: ScopeEnvelope | undefined;
      const port = new CoordinatedAgentExecutionPort({
        delegate: vi.fn(async () => {
          seen = currentScopeEnvelope();
          return {
            execution_kind: 'agent_delegation' as const,
            task_id: 't',
            agent_id: 'a',
            status: 'succeeded' as const,
            output: 'done',
          };
        }),
      });
      await port.delegate({
        work_item_id: itemId,
        task_id: 't',
        mission_id: 'MSN-C',
        agent_id: 'a',
        security_scope: scope as never,
        instruction: 'go',
        idempotency_key: `idem-${itemId}`,
      });
      return seen;
    };
    const requested = {
      tenant_slug: 'victim',
      mission_id: 'MSN-C',
      read_tiers: ['public', 'confidential', 'personal'],
      write_tier: 'personal',
      external_egress: 'allow',
      purpose: 'caller-declared',
    };

    afterEach(() => vi.unstubAllEnvs());

    it('runs unenveloped when the process is not bound to the requested mission', async () => {
      vi.stubEnv('MISSION_ID', '');
      expect(await delegateAndObserve(requested, 'WI-MINT-001')).toBeUndefined();
      vi.stubEnv('MISSION_ID', 'MSN-OTHER');
      expect(await delegateAndObserve(requested, 'WI-MINT-002')).toBeUndefined();
    });

    it('clamps a minted policy to the process tier and ignores request tenant and egress', async () => {
      vi.stubEnv('MISSION_ID', 'MSN-C');
      vi.stubEnv('KYBERION_TIER', 'confidential');
      vi.stubEnv('KYBERION_TENANT', 'default');
      vi.stubEnv('KYBERION_SCOPE_ENV_PATH', 'active/shared/tmp/coordinated-missing-scope.env');
      const envelope = await delegateAndObserve(requested, 'WI-MINT-003');
      expect(envelope?.policy.read_tiers).toEqual(['public', 'confidential']);
      expect(envelope?.policy.write_tier).toBe('confidential');
      expect(envelope?.policy.external_egress).toBeUndefined();
      expect(envelope?.identity.tenant_slug).toBe('default');
    });
  });

  it('offers a convenience entry point that keeps WorkItem coordination enabled', async () => {
    clearWorkCoordinationStore();
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-002',
      title: 'convenience task',
      description: 'run through the convenience boundary',
      projectId: 'MSN-COORDINATED-002',
      status: 'ready',
    });
    const receipt = await delegateCoordinatedAgentTask(
      {
        work_item_id: item.item_id,
        task_id: 'task-2',
        mission_id: 'MSN-COORDINATED-002',
        security_scope: {
          tenant_id: 'default',
          mission_id: 'MSN-COORDINATED-002',
          read_tiers: ['public'],
          write_tier: 'public',
          purpose: 'convenience execution test',
        },
        instruction: 'execute the task',
        idempotency_key: 'coord-2',
      },
      {
        delegate: async (request) => ({
          execution_kind: 'agent_delegation' as const,
          task_id: request.task_id,
          agent_id: 'agent-2',
          status: 'succeeded' as const,
          output: 'done',
        }),
      },
      'test-convenience-agent'
    );
    expect(receipt.work_item_id).toBe(item.item_id);
    expect(getWorkItem(item.item_id)?.status).toBe('done');
  });

  it('keeps CLI subagent execution on the shared attempt and lease boundary', async () => {
    clearWorkCoordinationStore();
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-CLI',
      title: 'CLI lifecycle task',
      description: 'run the native CLI subagent through coordination',
      projectId: 'MSN-COORDINATED-CLI',
      status: 'ready',
    });
    const receipt = await delegateCoordinatedCliSubagentTask(
      {
        work_item_id: item.item_id,
        task_id: 'task-cli',
        mission_id: 'MSN-COORDINATED-CLI',
        success_status: 'done',
        security_scope: {
          tenant_id: 'default',
          mission_id: 'MSN-COORDINATED-CLI',
          read_tiers: ['public'],
          write_tier: 'public',
          purpose: 'CLI lifecycle test',
        },
        instruction: 'execute the CLI task',
        idempotency_key: 'coord-cli',
      },
      async () => ({
        execution_kind: 'agent_delegation' as const,
        task_id: 'task-cli',
        agent_id: 'cli-agent',
        provider: 'codex-cli',
        model_id: 'gpt-5.6-luna',
        native_subagent: { mode: 'native-subagent', model: 'gpt-5.6-luna' },
        status: 'succeeded' as const,
        output_ref: `${item.item_id}:result`,
        output: 'done',
      }),
      'cli-agent'
    );

    const stored = getWorkItem(item.item_id);
    expect(receipt.attempt_id).toEqual(stored?.metadata?.attempt_id);
    expect(stored?.attempts?.[0]?.attempt_id).toEqual(expect.any(String));
    expect(stored).toMatchObject({
      status: 'done',
      metadata: {
        work_item_id: item.item_id,
        attempt_id: expect.any(String),
        output_ref: `${item.item_id}:result`,
        lease_status: 'released',
        execution_status: 'succeeded',
      },
    });
    expect(stored?.attempts?.map((attempt) => attempt.status)).toEqual(['released']);
    expect(listActiveWorkLeases()).toHaveLength(0);
  });

  it('closes against the latest leased version after an observability metadata bump', async () => {
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-VERSION-BUMP',
      title: 'version bump task',
      description: 'runtime metadata changes while the provider is running',
      projectId: 'MSN-COORDINATED-VERSION-BUMP',
      status: 'ready',
    });
    const port = new CoordinatedAgentExecutionPort({
      delegate: vi.fn(async () => {
        const claimed = getWorkItem(item.item_id);
        expect(claimed?.status).toBe('in_progress');
        updateWorkItem({
          itemId: item.item_id,
          expectedVersion: claimed?.version,
          metadata: { runtime_observation: 'provider response received' },
        });
        return {
          execution_kind: 'agent_delegation' as const,
          task_id: 'task-version-bump',
          agent_id: 'agent-version-bump',
          status: 'succeeded' as const,
          output: 'done',
        };
      }),
    });

    await expect(
      port.delegate({
        work_item_id: item.item_id,
        task_id: 'task-version-bump',
        mission_id: 'MSN-COORDINATED-VERSION-BUMP',
        security_scope: {
          tenant_id: 'default',
          mission_id: 'MSN-COORDINATED-VERSION-BUMP',
          read_tiers: ['public'],
          write_tier: 'public',
          purpose: 'version bump test',
        },
        instruction: 'execute the task',
        idempotency_key: 'coord-version-bump',
      })
    ).resolves.toMatchObject({ status: 'succeeded' });

    expect(getWorkItem(item.item_id)).toMatchObject({
      status: 'done',
      metadata: { runtime_observation: 'provider response received' },
    });
    expect(listActiveWorkLeases()).toHaveLength(0);
  });

  it('fails closed when the lease is transferred before the original worker closes the item', async () => {
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-LEASE-TRANSFER',
      title: 'lease transfer task',
      description: 'the provider returns after another worker owns the lease',
      projectId: 'MSN-COORDINATED-LEASE-TRANSFER',
      status: 'ready',
    });
    let transferredLeaseId: string | undefined;
    const port = new CoordinatedAgentExecutionPort({
      delegate: vi.fn(async () => {
        const claimed = getWorkItem(item.item_id);
        expect(claimed).toMatchObject({
          status: 'in_progress',
          lease_id: expect.any(String),
        });
        const released = releaseWorkItem({
          itemId: item.item_id,
          leaseId: claimed?.lease_id as string,
          actorPeerId: 'coordinated-agent-execution-port',
          nextStatus: 'ready',
          expectedVersion: claimed?.version,
        });
        const transferred = claimWorkItem({
          itemId: item.item_id,
          actorPeerId: 'replacement-agent',
          purpose: 'take over the transferred provider task',
          expectedVersion: released.item.version,
          idempotencyKey: 'coord-lease-transfer-replacement',
        });
        transferredLeaseId = transferred.lease.lease_id;
        return {
          execution_kind: 'agent_delegation' as const,
          task_id: 'task-lease-transfer',
          agent_id: 'agent-lease-transfer',
          status: 'succeeded' as const,
          output: 'late provider response',
        };
      }),
    });

    await expect(
      port.delegate({
        work_item_id: item.item_id,
        task_id: 'task-lease-transfer',
        mission_id: 'MSN-COORDINATED-LEASE-TRANSFER',
        security_scope: {
          tenant_id: 'default',
          mission_id: 'MSN-COORDINATED-LEASE-TRANSFER',
          read_tiers: ['public'],
          write_tier: 'public',
          purpose: 'lease transfer test',
        },
        instruction: 'execute the task',
        idempotency_key: 'coord-lease-transfer',
      })
    ).rejects.toThrow(/version conflict/i);

    expect(transferredLeaseId).toEqual(expect.any(String));
    expect(getWorkItem(item.item_id)).toMatchObject({
      status: 'in_progress',
      lease_id: transferredLeaseId,
      claimed_by_peer_id: 'replacement-agent',
    });
    expect(listActiveWorkLeases()).toHaveLength(1);
  });

  it('keeps review-required work items in review after successful execution', async () => {
    clearWorkCoordinationStore();
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-REVIEW',
      title: 'review task',
      description: 'execute then review',
      projectId: 'MSN-COORDINATED-REVIEW',
      status: 'ready',
    });
    await delegateCoordinatedAgentTask(
      {
        work_item_id: item.item_id,
        task_id: 'task-review',
        mission_id: 'MSN-COORDINATED-REVIEW',
        success_status: 'review',
        security_scope: {
          tenant_id: 'default',
          mission_id: 'MSN-COORDINATED-REVIEW',
          read_tiers: ['public'],
          write_tier: 'public',
          purpose: 'review transition test',
        },
        instruction: 'execute review task',
        idempotency_key: 'coord-review',
      },
      {
        delegate: async (request) =>
          ({
            execution_kind: 'agent_delegation',
            task_id: request.task_id,
            agent_id: 'agent-review',
            status: 'succeeded',
            output: 'done',
          }) as const,
      }
    );
    expect(getWorkItem(item.item_id)?.status).toBe('review');
  });

  it('logs a structured error and blocks the work item when the delegate throws (e.g. sandbox failure)', async () => {
    clearWorkCoordinationStore();
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-SANDBOX-THROW',
      title: 'sandbox failure task',
      description: 'provider CLI subagent rejects due to a sandbox restriction',
      projectId: 'MSN-COORDINATED-SANDBOX-THROW',
      status: 'ready',
    });
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const port = new CoordinatedAgentExecutionPort({
      delegate: vi.fn(async () => {
        throw new Error('sandbox denied: permission to spawn provider CLI was refused');
      }),
    });

    await expect(
      port.delegate({
        work_item_id: item.item_id,
        task_id: 'task-sandbox-throw',
        mission_id: 'MSN-COORDINATED-SANDBOX-THROW',
        security_scope: {
          tenant_id: 'default',
          mission_id: 'MSN-COORDINATED-SANDBOX-THROW',
          read_tiers: ['public'],
          write_tier: 'public',
          purpose: 'sandbox failure test',
        },
        instruction: 'execute the task',
        idempotency_key: 'coord-sandbox-throw',
      })
    ).rejects.toThrow('sandbox denied');

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('sandbox denied: permission to spawn provider CLI was refused')
    );
    expect(getWorkItem(item.item_id)).toMatchObject({
      status: 'blocked',
      metadata: expect.objectContaining({
        result: expect.objectContaining({
          error: expect.stringContaining('sandbox denied'),
        }),
      }),
    });
    loggerErrorSpy.mockRestore();
  });

  it('logs a structured error when the delegate returns a failed receipt without throwing', async () => {
    clearWorkCoordinationStore();
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-SANDBOX-RECEIPT',
      title: 'sandbox failure receipt task',
      description: 'provider CLI subagent returns a failed receipt instead of throwing',
      projectId: 'MSN-COORDINATED-SANDBOX-RECEIPT',
      status: 'ready',
    });
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const port = new CoordinatedAgentExecutionPort({
      delegate: vi.fn(async (request) => ({
        execution_kind: 'agent_delegation' as const,
        task_id: request.task_id,
        agent_id: 'agent-sandbox',
        status: 'failed' as const,
        error: 'sandbox denied: no Bash/shell execution tool available in this session',
      })),
    });

    const receipt = await port.delegate({
      work_item_id: item.item_id,
      task_id: 'task-sandbox-receipt',
      mission_id: 'MSN-COORDINATED-SANDBOX-RECEIPT',
      security_scope: {
        tenant_id: 'default',
        mission_id: 'MSN-COORDINATED-SANDBOX-RECEIPT',
        read_tiers: ['public'],
        write_tier: 'public',
        purpose: 'sandbox failure receipt test',
      },
      instruction: 'execute the task',
      idempotency_key: 'coord-sandbox-receipt',
    });

    expect(receipt.status).toBe('failed');
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('sandbox denied: no Bash/shell execution tool available')
    );
    expect(getWorkItem(item.item_id)?.status).toBe('blocked');
    loggerErrorSpy.mockRestore();
  });

  it('never stores customer_decisions from a delegation output, and returns the reply as is (CD-09)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-CD09',
      title: 'coordinated task',
      description: 'run through the shared execution boundary',
      projectId: 'MSN-COORDINATED-CD09',
      status: 'ready',
    });
    const output = [
      '```task_result',
      JSON.stringify({
        summary: 'done',
        artifacts: [],
        verification_done: ['checked'],
        gaps: [],
        needs: [],
        customer_decisions: [
          {
            question: 'Which secret colour theme?',
            item: 'UX',
            key: 'ui.theme',
            proposed_value: 'secret-dark',
            requires_customer: false,
          },
        ],
      }),
      '```',
    ].join('\n');
    const receipt = await delegateCoordinatedCliSubagentTask(
      {
        work_item_id: item.item_id,
        task_id: 'task-cd09',
        mission_id: 'MSN-COORDINATED-CD09',
        security_scope: {
          tenant_id: 'default',
          mission_id: 'MSN-COORDINATED-CD09',
          read_tiers: ['public'],
          write_tier: 'public',
          purpose: 'coordinated execution test',
        },
        instruction: 'execute the task',
        idempotency_key: 'coord-cd09',
      },
      async () => ({
        execution_kind: 'agent_delegation' as const,
        task_id: 'task-cd09',
        agent_id: 'agent-1',
        status: 'succeeded' as const,
        output_ref: `${item.item_id}:result`,
        output,
      })
    );
    // The caller gets its reply untouched; only what the port stores is stripped.
    expect(receipt.output).toBe(output);
    const stored = JSON.stringify(getWorkItem(item.item_id));
    expect(stored).not.toMatch(/secret|ui\.theme/u);
    expect(stored).toContain('summary');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('customer_decisions left out of the stored WorkItem record')
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|ui\.theme/u);
    warn.mockRestore();
  });

  it('the reasoning-backend adapter chain hands the caller its reply with customer_decisions intact (CD-09)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { delegateWorkItemWithReasoningBackend } =
      await import('./reasoning/reasoning-backend-execution-adapter.js');
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-CD09-ADAPTER',
      title: 'adapter task',
      description: 'run through the reasoning backend adapter',
      projectId: 'MSN-COORDINATED-CD09',
      status: 'ready',
    });
    const reply = [
      '```task_result',
      JSON.stringify({
        summary: 'done',
        artifacts: [],
        verification_done: ['checked'],
        gaps: [],
        needs: [],
        customer_decisions: [
          { question: 'Secret?', item: 'UX', key: 'ui.theme', requires_customer: true },
        ],
      }),
      '```',
    ].join('\n');
    const backend = {
      name: 'stub',
      delegateTask: vi.fn(async () => reply),
    } as unknown as Parameters<typeof delegateWorkItemWithReasoningBackend>[0];
    const receipt = await delegateWorkItemWithReasoningBackend(backend, {
      work_item_id: item.item_id,
      task_id: 'task-adapter',
      mission_id: 'MSN-COORDINATED-CD09',
      security_scope: {
        tenant_id: 'default',
        mission_id: 'MSN-COORDINATED-CD09',
        read_tiers: ['public'],
        write_tier: 'public',
        purpose: 'coordinated execution test',
      },
      instruction: 'execute the task',
      idempotency_key: 'coord-cd09-adapter',
    });
    expect(receipt.output).toBe(reply);
    expect(JSON.stringify(getWorkItem(item.item_id))).not.toMatch(/Secret|ui\.theme/u);
    warn.mockRestore();
  });
});
