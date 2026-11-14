import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedFirstJobTestRoot } from '../../../scripts/fixtures/first-job-approval-fixture.js';
import { safeRmSync as removeFixture } from '../secure-io.js';
import { withExecutionContext as inSourceContext } from '../authority.js';
import type { AgentExecutionReceipt, AgentTaskEnvelope } from '../agent/agent-execution-port.js';

// Only installed host identity and audit persistence are synthetic. The actual
// claim, lease, attempt, attribution, envelope, admission and binding compose here.
const installed = vi.hoisted(() => ({
  ready: true,
  ownerId: 'user:personal-owner',
  agentId: 'kyberion://agent/_/_/personal-worker',
  agentActive: true,
}));
vi.mock('../organization/personal-runtime-identity.js', () => ({
  inspectInstalledPersonalRuntime: () => ({ ...installed }),
}));

const sourceRoot = process.cwd();
const root = path.join(sourceRoot, 'active/shared/tmp', `personal-dispatch-${randomUUID()}`);
const mission = 'MSN-PERSONAL-DISPATCH';
const project = 'PRJ-PERSONAL-DISPATCH';
const task = 'personal-task';
let authority: typeof import('../authority.js');
let coordination: typeof import('../workforce/work-coordination.js');
let scopes: typeof import('../scope-envelope.js');
let credentials: typeof import('../foundation/credential-binding.js');
let storage: typeof import('./secret-guard.js');
let resolver: typeof import('./secret-resolver.js');
let actors: typeof import('../authn/actor-context.js');
let portModule: typeof import('../agent/coordinated-agent-execution-port.js');
let dispatch: typeof import('./task-credential-dispatch.js');

beforeAll(async () => {
  seedFirstJobTestRoot(sourceRoot, root);
  process.chdir(root);
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('VITEST', '');
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('KYBERION_BASE_ROLE', 'ecosystem_architect');
  vi.stubEnv('KYBERION_NHI_ACTOR', 'off');
  vi.stubEnv('TEST_OPERATOR_ONLY', 'synthetic-operator-value');
  for (const key of [
    'SYSTEM_ROLE',
    'MISSION_ID',
    'KYBERION_TENANT',
    'KYBERION_TASK_ID',
    'KYBERION_ORGANIZATION_ID',
    'KYBERION_PROJECT_ID',
    'KYBERION_SUDO',
    'KYBERION_STANCE',
    'KYBERION_CUSTOMER',
  ])
    vi.stubEnv(key, '');
  vi.resetModules();
  authority = await import('../authority.js');
  await import('../secure-io.js');
  const { auditChain } = await import('../governance/audit-chain.js');
  // Bootstrap registers the real locking/store boundaries before replacing sinks.
  vi.spyOn(auditChain, 'record').mockImplementation((entry) => entry as never);
  vi.spyOn(auditChain, 'recordDeferrable').mockImplementation((entry) => entry as never);
  vi.spyOn(auditChain, 'recordDurable').mockImplementation((entry) => entry as never);
  const { pathResolver } = await import('../path-resolver.js');
  expect(pathResolver.rootDir()).toBe(root);
  expect(pathResolver.primaryCheckoutRootDir()).toBe(root);
  coordination = await import('../workforce/work-coordination.js');
  scopes = await import('../scope-envelope.js');
  credentials = await import('../foundation/credential-binding.js');
  storage = await import('./secret-guard.js');
  resolver = await import('./secret-resolver.js');
  actors = await import('../authn/actor-context.js');
  portModule = await import('../agent/coordinated-agent-execution-port.js');
  dispatch = await import('./task-credential-dispatch.js');
  coordination.setWorkCoordinationNamespace(`vitest-personal-dispatch-${randomUUID()}`);
}, 60000);

beforeEach(() => {
  installed.ready = true;
  installed.agentActive = true;
  installed.ownerId = 'user:personal-owner';
  resolver.resetSecretResolver();
  scopes.resetScopeEnvelopeState();
  coordination.clearWorkCoordinationStore();
});

afterAll(async () => {
  await import('../governance/audit-chain.js');
  resolver?.resetSecretResolver();
  coordination?.clearWorkCoordinationStore();
  coordination?.setWorkCoordinationNamespace(null);
  scopes?.resetScopeEnvelopeState();
  process.chdir(sourceRoot);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  inSourceContext('ecosystem_architect', () =>
    removeFixture(root, { recursive: true, force: true })
  );
});

function createItem() {
  return coordination.createWorkItem({
    title: 'Synthetic personal task',
    description: 'Credential-free local computation',
    projectId: project,
    status: 'ready',
    context: { project_id: project, mission_id: mission, task_id: task },
  });
}
function request(itemId: string) {
  return {
    work_item_id: itemId,
    task_id: task,
    mission_id: mission,
    instruction: 'Compute locally without credentials',
    security_scope: {
      project_id: project,
      mission_id: mission,
      task_id: task,
      read_tiers: ['public' as const],
      write_tier: 'public' as const,
      purpose: 'personal fixture',
    },
  };
}
function receipt(input: AgentTaskEnvelope): AgentExecutionReceipt {
  return {
    execution_kind: 'agent_delegation',
    task_id: input.task_id,
    agent_id: installed.agentId,
    status: 'succeeded',
  };
}
function inPersonalScope<T>(run: () => T): T {
  const parent = scopes.mintScopeEnvelope({
    env: { KYBERION_TIER: 'public', KYBERION_PROJECT_ID: project, MISSION_ID: mission },
    policy: { purpose: 'personal fixture' },
  });
  return authority.withExecutionContext(
    'chronos_gateway',
    () => scopes.withScopeEnvelope(parent, run),
    'worker',
    undefined,
    undefined,
    { missionId: mission, projectId: project, taskId: task }
  );
}

describe('personal claimed dispatch composition', () => {
  it('runs with an empty binding, current claim identity and no operator or resolver fallback', async () => {
    const item = createItem();
    const binder = vi.fn();
    resolver.registerSecretResolver({
      name: 'must-not-run',
      resolve: () => 'operator-secret',
      bindTask: binder,
    });
    const operatorIdentity = credentials.credentialExecutionIdentity();
    const port = new portModule.CoordinatedAgentExecutionPort(
      {
        delegate: async (input) => {
          const held = coordination.getWorkItem(item.item_id)!;
          expect(credentials.credentialBindingReadiness().status).toBe('bound');
          expect(credentials.credentialExecutionIdentity()).toMatchObject({
            tenantSlug: undefined,
            missionId: mission,
            taskId: task,
            personalClaim: {
              ownerId: installed.ownerId,
              actorId: installed.agentId,
              workItemId: item.item_id,
              attemptId: held.current_attempt_id,
              leaseId: held.lease_id,
            },
          });
          expect(actors.currentActor()).toMatchObject({
            actor: { id: installed.agentId },
            provenance: 'claim',
          });
          expect(authority.resolveRole()).toBe('chronos_gateway');
          expect(storage.getSecret('TEST_OPERATOR_ONLY')).toBeNull();
          expect(() =>
            credentials.resolveProviderApiCredential(['TEST_OPERATOR_ONLY'], 'ambient')
          ).toThrow('CREDENTIAL_KEY_UNAVAILABLE');
          expect(() => credentials.resolveTaskProviderEnvironment('gws')).toThrow(
            'CREDENTIAL_PROVIDER_DENIED'
          );
          expect(() => credentials.assertCredentialOwner(operatorIdentity)).toThrow(
            'CREDENTIAL_OWNER_DENIED'
          );
          expect(() => storage.loadConnectionDocument('slack')).toThrow(
            'CREDENTIAL_CONNECTION_DENIED'
          );
          return receipt(input);
        },
      },
      installed.agentId
    );
    expect((await inPersonalScope(() => port.delegate(request(item.item_id)))).status).toBe(
      'succeeded'
    );
    expect(binder).not.toHaveBeenCalled();
    expect(coordination.getWorkItem(item.item_id)?.status).toBe('done');
    expect(coordination.listActiveWorkLeases()).toHaveLength(0);
    expect(credentials.hasTaskCredentialBinding()).toBe(false);
    expect(credentials.resolveTaskCredential('TEST_OPERATOR_ONLY')).toBeUndefined();
  });

  it.each(['inactive', 'owner'] as const)(
    'rejects consumption after installed %s changes',
    async (change) => {
      const item = createItem();
      const port = new portModule.CoordinatedAgentExecutionPort(
        {
          delegate: async (input) => {
            const identity = credentials.credentialExecutionIdentity();
            expect(credentials.resolveTaskCredential('TEST_OPERATOR_ONLY')).toBeNull();
            if (change === 'inactive') installed.agentActive = false;
            else installed.ownerId = 'user:other-owner';
            expect(() => credentials.resolveTaskCredential('TEST_OPERATOR_ONLY')).toThrow(
              /CREDENTIAL_/
            );
            expect(() => credentials.assertCredentialOwner(identity)).toThrow(/CREDENTIAL_/);
            installed.agentActive = true;
            installed.ownerId = 'user:personal-owner';
            return receipt(input);
          },
        },
        installed.agentId
      );
      await inPersonalScope(() => port.delegate(request(item.item_id)));
    }
  );

  it('denies subsequent consumption after the real lease is released', async () => {
    const item = createItem();
    let denied = false;
    const port = new portModule.CoordinatedAgentExecutionPort(
      {
        delegate: async (input) => {
          const held = coordination.getWorkItem(item.item_id)!;
          coordination.releaseWorkItem({
            itemId: held.item_id,
            leaseId: held.lease_id!,
            actorPeerId: installed.agentId,
            expectedVersion: held.version,
            nextStatus: 'ready',
          });
          expect(() => credentials.resolveTaskCredential('TEST_OPERATOR_ONLY')).toThrow(
            'CREDENTIAL_PERSONAL_CLAIM_DENIED'
          );
          denied = true;
          return receipt(input);
        },
      },
      installed.agentId
    );
    // Completion cannot overwrite the released claim either.
    await expect(inPersonalScope(() => port.delegate(request(item.item_id)))).rejects.toThrow();
    expect(denied).toBe(true);
    expect(coordination.getWorkItem(item.item_id)?.status).toBe('ready');
    expect(coordination.listActiveWorkLeases()).toHaveLength(0);
  });

  it('rejects another nested WorkItem even when its mission and task match', async () => {
    const item = createItem();
    const other = createItem();
    const nested = vi.fn();
    const port = new portModule.CoordinatedAgentExecutionPort(
      {
        delegate: async (input) => {
          await expect(
            dispatch.withConfiguredTaskCredentials(other.item_id, nested)
          ).rejects.toThrow('CREDENTIAL_SCOPE_DENIED');
          expect(nested).not.toHaveBeenCalled();
          expect(credentials.resolveTaskCredential('TEST_OPERATOR_ONLY')).toBeNull();
          return receipt(input);
        },
      },
      installed.agentId
    );
    await inPersonalScope(() => port.delegate(request(item.item_id)));
    expect(coordination.getWorkItem(other.item_id)?.status).toBe('ready');
  });

  it.each(['missing-envelope', 'legacy-actor'] as const)(
    'rejects %s before running the delegate',
    async (mode) => {
      const item = createItem();
      const delegate = vi.fn();
      const port = new portModule.CoordinatedAgentExecutionPort(
        { delegate },
        mode === 'legacy-actor' ? 'legacy-peer' : installed.agentId
      );
      const execute = () =>
        port.delegate(
          mode === 'missing-envelope'
            ? {
                work_item_id: item.item_id,
                task_id: task,
                mission_id: mission,
                instruction: 'No envelope',
              }
            : request(item.item_id)
        );
      await expect(
        mode === 'missing-envelope' ? execute() : inPersonalScope(execute)
      ).rejects.toThrow(/CREDENTIAL_/);
      expect(delegate).not.toHaveBeenCalled();
      expect(coordination.getWorkItem(item.item_id)?.status).toBe('blocked');
      expect(coordination.listActiveWorkLeases()).toHaveLength(0);
    }
  );
});
