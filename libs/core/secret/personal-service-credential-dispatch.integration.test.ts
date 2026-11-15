import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { safeReadFile } from '../secure-io.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOnboardingAuthorityFixture } from '../../../tests/helpers/onboarding-authority-fixture.js';
import type { AgentExecutionReceipt, AgentTaskEnvelope } from '../agent/agent-execution-port.js';

// Real installed identity, signed owner approval, encrypted account, claim, broker and actuator.
// Only the external HTTP transport is intercepted; no real account or credentials are used.
const http = vi.hoisted(() =>
  vi.fn(async (_options: unknown) => ({ ok: true, messages: { matches: [] } }))
);
vi.mock('../network.js', async (original) => ({
  ...(await original<typeof import('../network.js')>()),
  secureFetch: http,
}));
const f = useOnboardingAuthorityFixture();
const manifestBytes = safeReadFile(
  path.join(process.cwd(), 'libs/actuators/service-actuator/manifest.json')
);
const project = 'PRJ-PERSONAL-SERVICE';
const mission = 'MSN-PERSONAL-SERVICE';
const task = 'service-read';
const action = 'search_messages';
const address = {
  bindingId: 'personal-slack',
  serviceId: 'slack',
  ownerKind: 'person' as const,
  ownerRef: 'user:owner',
};
let cleanup: (() => void) | undefined;

async function setup() {
  const authority = await import('../authority.js');
  const io = await import('../secure-io.js');
  authority.withExecutionContext('ecosystem_architect', () => {
    const directory = path.join(f.root, 'libs/actuators/service-actuator');
    io.safeMkdir(directory, { recursive: true });
    io.safeWriteFile(path.join(directory, 'manifest.json'), manifestBytes);
  });
  const coordination = await import('../workforce/work-coordination.js');
  const scopes = await import('../scope-envelope.js');
  const credentials = await import('../foundation/credential-binding.js');
  const guard = await import('./secret-guard.js');
  const encryption = await import('./secret-encryption.js');
  const resolver = await import('./secret-resolver.js');
  const allocations = await import('./credential-allocations.js');
  const grants = await import('../governance/personal-credential-grant.js');
  const bindingStore = await import('../service/service-binding-registry.js');
  const portModule = await import('../agent/coordinated-agent-execution-port.js');
  const actuator = await import('../../actuators/service-actuator/src/service-actuator-helpers.js');
  const broker = await import('./personal-service-credential-broker.js');
  const serviceBinding = await import('../service/service-binding.js');
  http.mockClear();
  encryption.overrideSecretEncryptionKeyForTests(Buffer.alloc(32, 29));
  resolver.resetSecretResolver();
  allocations.installLocalCredentialAllocations();
  coordination.setWorkCoordinationNamespace(`vitest-personal-service-${randomUUID()}`);
  cleanup = () =>
    f.run(() => {
      coordination.clearWorkCoordinationStore();
      coordination.setWorkCoordinationNamespace(null);
      resolver.resetSecretResolver();
      encryption.overrideSecretEncryptionKeyForTests(null);
    });
  const binding = {
    binding_id: address.bindingId,
    service_id: 'slack',
    service_type: 'slack',
    scope: 'personal',
    target: 'synthetic-workspace',
    owner_kind: 'person' as const,
    owner_ref: 'user:owner',
    auth_mode: 'secret-guard' as const,
    secret_refs: ['SLACK_TOKEN'],
    allowed_actions: [action],
    approval_policy: { [action]: 'allowed' as const },
  };
  const reference = f.run(() => {
    bindingStore.saveServiceBindingRecord(binding);
    const ref = guard.storeLocalAccountMaterial(address, {
      SLACK_TOKEN: 'synthetic-personal-api-token',
    });
    guard.storeLocalAccountRegistration(address, { generation: ref.generation });
    return ref;
  });
  const selection = {
    bindingId: address.bindingId,
    projectId: project,
    missionId: mission,
    taskId: task,
    allowedActions: [action],
    purpose: 'Synthetic claimed read',
    ttlDays: 1,
  };
  const approval = f.run(() =>
    grants.requestPersonalCredentialGrantApproval(f.principal, selection)
  );
  f.personal(() => {
    const record = f.approvals.loadApprovalRequest('grant-standing', approval.id)!;
    f.approvals.decideApprovalRequest('mission_controller', {
      channel: record.channel,
      requestId: record.id,
      decision: 'approved',
      decidedBy: f.viewer.principal.actor.id,
      decidedByRole: 'owner',
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'surface_session',
      deciderPrincipal: f.viewer.principal,
      presentedDigest: f.approvals.computeApprovalPresentedDigest(record),
      payloadHash: record.accountability?.payloadHash,
      effectBinding: record.accountability?.effectBinding,
    });
  });
  const grant = f.run(() => grants.grantPersonalCredentialUse(f.principal, selection, approval.id));
  const input = () => ({
    service_id: 'slack',
    mode: 'PRESET' as const,
    action,
    auth: 'secret-guard' as const,
    params: { query: 'synthetic query' },
    context: {
      service_binding_id: address.bindingId,
      personal_credential_grant_id: grant.grant_id,
      security_scope: {
        project_id: project,
        mission_id: mission,
        task_id: task,
        read_tiers: ['public'],
        write_tier: 'public',
        purpose: 'synthetic service read',
        external_egress: 'allow',
      },
    },
  });
  const dispatch = async (body: (itemId: string) => Promise<void>) => {
    const item = f.run(() =>
      coordination.createWorkItem({
        title: 'Synthetic service read',
        description: 'Read selected personal account',
        projectId: project,
        status: 'ready',
        context: { project_id: project, mission_id: mission, task_id: task },
      })
    );
    const port = new portModule.CoordinatedAgentExecutionPort(
      {
        delegate: async (request: AgentTaskEnvelope): Promise<AgentExecutionReceipt> => {
          await body(item.item_id);
          return {
            execution_kind: 'agent_delegation',
            task_id: request.task_id,
            agent_id: f.installedId,
            status: 'succeeded',
          };
        },
      },
      f.installedId
    );
    const parent = scopes.mintScopeEnvelope({
      env: { KYBERION_TIER: 'public', KYBERION_PROJECT_ID: project, MISSION_ID: mission },
      policy: {
        purpose: 'synthetic claimed service',
        read_tiers: ['public'],
        write_tier: 'public',
        external_egress: 'allow',
      },
    });
    return authority.withExecutionContext(
      'chronos_gateway',
      () =>
        scopes.withScopeEnvelope(parent, () =>
          port.delegate({
            work_item_id: item.item_id,
            task_id: task,
            mission_id: mission,
            instruction: 'Read the selected synthetic account',
            security_scope: {
              project_id: project,
              mission_id: mission,
              task_id: task,
              read_tiers: ['public'],
              write_tier: 'public',
              purpose: 'synthetic read',
              external_egress: 'allow',
            },
          })
        ),
      'worker',
      undefined,
      undefined,
      { missionId: mission, projectId: project, taskId: task }
    );
  };
  return {
    guard,
    reference,
    grant,
    grants,
    input,
    dispatch,
    actuator,
    credentials,
    scopes,
    coordination,
    resolver,
    broker,
    serviceBinding,
    binding,
  };
}
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe('personal consent to claimed service transport', () => {
  it('uses only the approved account at the actual actuator boundary and expires cached getters', async () => {
    const x = await setup();
    await x.dispatch(async () => {
      const envelope = x.scopes.currentScopeEnvelope();
      expect(x.credentials.resolveTaskCredential('SLACK_TOKEN')).toBeNull();
      expect(() => x.guard.loadConnectionDocument('slack')).toThrow();
      expect(() => x.credentials.resolveTaskProviderEnvironment('gws')).toThrow();
      await x.actuator.handleAction(x.input());
      expect(http).toHaveBeenCalledOnce();
      expect(http.mock.calls[0]?.[0]).toMatchObject({
        method: 'GET',
        url: 'https://slack.com/api/search.messages',
        headers: { Authorization: 'Bearer synthetic-personal-api-token' },
        maxRedirects: 0,
      });
      expect(x.scopes.currentScopeEnvelope()).toBe(envelope);
      let cached: ReturnType<typeof x.serviceBinding.resolveServiceBinding> | undefined;
      await x.broker.withPersonalServiceCredentialUse(
        { serviceId: 'slack', action, bindingId: address.bindingId, grantId: x.grant.grant_id },
        async (capability) => {
          cached = x.serviceBinding.resolveServiceBinding(
            'slack',
            'secret-guard',
            undefined,
            x.binding,
            undefined,
            capability
          );
          expect(cached.accessToken).toBe('synthetic-personal-api-token');
        }
      );
      expect(() => cached!.accessToken).toThrow();
      expect(x.credentials.resolveTaskCredential('SLACK_TOKEN')).toBeNull();
    });
  });
  it.each(['revoked', 'rotated'] as const)(
    'rejects %s consent before a later HTTP request',
    async (change) => {
      const x = await setup();
      await x.dispatch(async () => {
        await x.actuator.handleAction(x.input());
      });
      expect(http).toHaveBeenCalledOnce();
      f.run(() => {
        if (change === 'revoked')
          x.grants.revokePersonalCredentialGrant(
            f.principal,
            x.grant.grant_id,
            'synthetic withdrawal'
          );
        else {
          const next = x.guard.storeLocalAccountMaterial(address, {
            SLACK_TOKEN: 'synthetic-rotated-token',
          });
          x.guard.storeLocalAccountRegistration(address, { generation: next.generation });
        }
      });
      await x.dispatch(async () => {
        await expect(x.actuator.handleAction(x.input())).rejects.toThrow();
      });
      expect(http).toHaveBeenCalledOnce();
    }
  );
  it('rejects a different selection and a released actual lease before HTTP', async () => {
    const x = await setup();
    await expect(
      x.dispatch(async (itemId) => {
        const input = x.input();
        input.context.service_binding_id = 'another-binding';
        await expect(x.actuator.handleAction(input)).rejects.toThrow();
        expect(http).not.toHaveBeenCalled();
        const held = x.coordination.getWorkItem(itemId)!;
        x.coordination.releaseWorkItem({
          itemId,
          leaseId: held.lease_id!,
          actorPeerId: f.installedId,
          expectedVersion: held.version,
          nextStatus: 'ready',
        });
        await expect(x.actuator.handleAction(x.input())).rejects.toThrow();
        expect(http).not.toHaveBeenCalled();
      })
    ).rejects.toThrow();
  });
  it('keeps no-resolver execution credential-free', async () => {
    const x = await setup();
    x.resolver.resetSecretResolver();
    await x.dispatch(async () => {
      await expect(x.actuator.handleAction(x.input())).rejects.toThrow();
    });
    expect(http).not.toHaveBeenCalled();
  });
});
