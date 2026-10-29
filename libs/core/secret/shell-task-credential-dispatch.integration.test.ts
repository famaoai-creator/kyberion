import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinatedAgentExecutionPort } from '../coordinated-agent-execution-port.js';
import { currentActor } from '../actor-context.js';
import {
  createWorkItem,
  getWorkItem,
  listActiveWorkLeases,
  clearWorkCoordinationStore,
  setWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';
import { getSecret } from './secret-guard.js';
import {
  resolveProviderApiCredential,
  resolveTaskCredential,
} from '../foundation/credential-binding.js';
import { installSecretResolverIfAvailable, resetSecretResolver } from './secret-resolver.js';
import {
  currentScopeEnvelope,
  mintScopeEnvelope,
  resetScopeEnvelopeState,
  withScopeEnvelope,
} from '../scope-envelope.js';

// Only the external secret service transport is substituted. Actor attribution,
// claims, attempt history, envelopes, adapter admission and task binding are real.
const transport = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) =>
      String(args[1]).includes('__KYBERION_TASK_BINDING__')
        ? transport(...args)
        : actual.execFileSync(...args),
  };
});

const tenant = 'vitest-binding-integration';
const organization = 'vitest-binding-org';
const project = 'PRJ-BINDING-INTEGRATION';
const mission = 'MSN-BINDING-INTEGRATION';
const task = 'task-integrate';
const actorId = 'kyberion://agent/vitest-binding/worker';
const parent = () =>
  mintScopeEnvelope({
    env: {
      KYBERION_TIER: 'confidential',
      KYBERION_TENANT: tenant,
      MISSION_ID: mission,
      KYBERION_ORGANIZATION_ID: organization,
      KYBERION_PROJECT_ID: project,
    },
    policy: { purpose: 'shell binding composition' },
  });

beforeEach(() => {
  vi.clearAllMocks();
  resetSecretResolver();
  resetScopeEnvelopeState();
  setWorkCoordinationNamespace(`vitest-shell-binding-${randomUUID()}`);
  vi.stubEnv('KYBERION_SCOPE_ENV_PATH', 'active/shared/tmp/vitest-binding-no-scope.env');
  vi.stubEnv('KYBERION_PROJECT_ID', '');
  vi.stubEnv('KYBERION_ORGANIZATION_ID', '');
  vi.stubEnv('KYBERION_TENANT', '');
  vi.stubEnv('MISSION_ID', '');
  vi.stubEnv('KYBERION_TASK_ID', '');
  vi.stubEnv('TEST_OPERATOR_ONLY', 'synthetic-operator-value');
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-operator-api-value');
  expect(
    installSecretResolverIfAvailable({
      KYBERION_SECRET_RESOLVER_COMMAND: 'trusted-resolver {{key}} {{scope}}',
    })
  ).toBe(true);
});
afterEach(() => {
  resetSecretResolver();
  clearWorkCoordinationStore();
  setWorkCoordinationNamespace(null);
  resetScopeEnvelopeState();
  vi.unstubAllEnvs();
});

describe('configured shell task credentials through coordinated dispatch', () => {
  it('binds only within the real canonical claim callback and releases the WorkItem afterward', async () => {
    const item = createWorkItem({
      itemId: `WI-shell-${randomUUID()}`,
      title: 'Shell credential integration',
      description: 'Real claim, configured shell adapter and scoped API key',
      status: 'ready',
      projectId: project,
      context: {
        tenant_slug: tenant,
        organization_id: organization,
        project_id: project,
        mission_id: mission,
        task_id: task,
      },
    });
    transport.mockImplementation((_shell, _args, options) => {
      const request = JSON.parse(options.input);
      expect(request).toMatchObject({
        version: 1,
        workItemId: item.item_id,
        scope: { tenant_slug: tenant, mission_id: mission, task_id: task },
      });
      expect(currentActor()).toMatchObject({ actor: { id: actorId }, provenance: 'claim' });
      const held = getWorkItem(item.item_id)!;
      expect(held).toMatchObject({
        status: 'in_progress',
        claimed_by_peer_id: actorId,
        lease_id: expect.any(String),
        current_attempt_id: expect.any(String),
      });
      const attempt = held.attempts?.find((entry) => entry.run_id === held.current_attempt_id);
      expect(attempt).toMatchObject({ lease_id: held.lease_id, status: 'running' });
      expect(attempt?.attempt_id).not.toBe(held.current_attempt_id);
      expect(listActiveWorkLeases().some((lease) => lease.lease_id === held.lease_id)).toBe(true);
      return JSON.stringify({
        version: 1,
        secrets: { ANTHROPIC_API_KEY: 'synthetic-tenant-value' },
      });
    });
    const delegate = vi.fn(async (request) => {
      expect(currentScopeEnvelope()?.identity.task_id).toBe(task);
      expect(getSecret('ANTHROPIC_API_KEY')).toBe('synthetic-tenant-value');
      expect(
        resolveProviderApiCredential(['ANTHROPIC_API_KEY'], 'synthetic-operator-api-value')
      ).toBe('synthetic-tenant-value');
      expect(resolveTaskCredential('TEST_OPERATOR_ONLY')).toBeNull();
      expect(getSecret('TEST_OPERATOR_ONLY')).toBeNull();
      return {
        execution_kind: 'agent_delegation' as const,
        task_id: request.task_id,
        agent_id: actorId,
        status: 'succeeded' as const,
        output: 'bounded callback completed',
      };
    });
    await withScopeEnvelope(parent(), async () => {
      expect(() => getSecret('ANTHROPIC_API_KEY')).toThrow('CREDENTIAL_BINDING_REQUIRED');
      const port = new CoordinatedAgentExecutionPort({ delegate }, actorId);
      const receipt = await port.delegate({
        work_item_id: item.item_id,
        task_id: task,
        mission_id: mission,
        instruction: 'Read the scoped synthetic API key',
        security_scope: {
          tenant_slug: tenant,
          organization_id: organization,
          project_id: project,
          mission_id: mission,
          read_tiers: ['confidential'],
          write_tier: 'confidential',
          purpose: 'shell binding composition',
        },
      });
      expect(receipt.status).toBe('succeeded');
      expect(() => getSecret('ANTHROPIC_API_KEY')).toThrow('CREDENTIAL_BINDING_REQUIRED');
    });
    expect(delegate).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
    expect(getWorkItem(item.item_id)?.status).toBe('done');
    expect(getWorkItem(item.item_id)?.lease_id).toBeUndefined();
    expect(listActiveWorkLeases()).toHaveLength(0);
    expect(resolveTaskCredential('ANTHROPIC_API_KEY')).toBeUndefined();
  });

  it('blocks a mismatched typed task before contacting the secret service or delegate', async () => {
    const item = createWorkItem({
      itemId: `WI-drift-${randomUUID()}`,
      title: 'Mismatched task',
      description: 'Scope mismatch must not receive credentials',
      status: 'ready',
      projectId: project,
      context: {
        tenant_slug: tenant,
        organization_id: organization,
        project_id: project,
        mission_id: mission,
        task_id: 'another-task',
      },
    });
    const delegate = vi.fn();
    await expect(
      withScopeEnvelope(parent(), () =>
        new CoordinatedAgentExecutionPort({ delegate }, actorId).delegate({
          work_item_id: item.item_id,
          task_id: task,
          mission_id: mission,
          instruction: 'must not run',
          security_scope: {
            tenant_slug: tenant,
            organization_id: organization,
            project_id: project,
            mission_id: mission,
            read_tiers: ['confidential'],
            write_tier: 'confidential',
            purpose: 'shell binding composition',
          },
        })
      )
    ).rejects.toThrow('CREDENTIAL_BINDING_UNAVAILABLE');
    expect(transport).not.toHaveBeenCalled();
    expect(delegate).not.toHaveBeenCalled();
    expect(getWorkItem(item.item_id)?.status).toBe('blocked');
    expect(listActiveWorkLeases()).toHaveLength(0);
  });
});
