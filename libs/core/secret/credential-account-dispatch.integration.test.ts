import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedFirstJobTestRoot } from '../../../scripts/fixtures/first-job-approval-fixture.js';
import { safeRmSync as removeFixture } from '../secure-io.js';
import { withExecutionContext as inSourceContext } from '../authority.js';
import type { ServiceBindingRecord } from '../service/service-binding-registry.js';

// The approved grant basis and audit persistence sink are synthetic. Claim,
// actor, scope, allocation verifier, exact read authority, encrypted files and
// consumption are real. Audit persistence has its own integration coverage.
const state = vi.hoisted(() => ({ revoked: false }));
const tenant = 'account-runtime-test';
const organization = 'account-runtime-org';
const project = 'PRJ-ACCOUNT-RUNTIME';
const mission = 'MSN-ACCOUNT-RUNTIME';
const task = 'task-account';
const actorId = 'kyberion://agent/account-runtime-test/account-runtime-org/worker';
const selected: ServiceBindingRecord = {
  binding_id: 'personal-slack',
  service_id: 'slack',
  service_type: 'slack',
  scope: 'personal',
  target: 'synthetic-workspace',
  owner_kind: 'person',
  owner_ref: 'user:owner',
  auth_mode: 'secret-guard',
  secret_refs: ['SLACK_TOKEN'],
  allowed_actions: ['read'],
  approval_policy: { read: 'allowed' },
};
const grant = () => ({
  grant_id: 'GRT-ACCOUNT-FIXTURE',
  capability: 'credential.use',
  scope: {
    tenant_slug: tenant,
    service_allocation: {
      binding_id: selected.binding_id,
      service_id: 'slack',
      target: selected.target,
      owner_ref: 'user:owner',
      secret_refs: ['SLACK_TOKEN'],
      allowed_actions: ['read'],
      project_id: project,
      mission_id: mission,
      task_id: task,
    },
  },
});
vi.mock('../governance/grant-store.js', () => ({
  listGrants: () => [grant()],
  loadGrant: () => grant(),
  grantStatusAt: () => (state.revoked ? 'revoked' : 'active'),
  verifyGrantBasis: () => true,
}));

const sourceRoot = process.cwd();
const root = path.join(sourceRoot, 'active/shared/tmp', `account-runtime-${randomUUID()}`);
let authority: typeof import('../authority.js');
let io: typeof import('../secure-io.js');
let paths: typeof import('../path-resolver.js');
let storage: typeof import('./secret-guard.js');
let encryption: typeof import('./secret-encryption.js');
let coordination: typeof import('../workforce/work-coordination.js');
let scopes: typeof import('../scope-envelope.js');
let credentials: typeof import('../foundation/credential-binding.js');
let resolver: typeof import('./secret-resolver.js');
let allocations: typeof import('./credential-allocations.js');
let actors: typeof import('../authn/actor-context.js');
let portModule: typeof import('../agent/coordinated-agent-execution-port.js');
let reference: import('./secret-guard.js').LocalAccountMaterialReference;

beforeAll(async () => {
  seedFirstJobTestRoot(sourceRoot, root);
  process.chdir(root);
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('VITEST', '');
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('KYBERION_BASE_ROLE', 'ecosystem_architect');
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
  io = await import('../secure-io.js');
  const { auditChain } = await import('../governance/audit-chain.js');
  // Keep bootstrap registration real; isolate only the process-global audit sink.
  vi.spyOn(auditChain, 'record').mockImplementation((entry) => entry as never);
  vi.spyOn(auditChain, 'recordDeferrable').mockImplementation((entry) => entry as never);
  vi.spyOn(auditChain, 'recordDurable').mockImplementation((entry) => entry as never);
  paths = await import('../path-resolver.js');
  storage = await import('./secret-guard.js');
  encryption = await import('./secret-encryption.js');
  coordination = await import('../workforce/work-coordination.js');
  scopes = await import('../scope-envelope.js');
  credentials = await import('../foundation/credential-binding.js');
  resolver = await import('./secret-resolver.js');
  allocations = await import('./credential-allocations.js');
  actors = await import('../authn/actor-context.js');
  portModule = await import('../agent/coordinated-agent-execution-port.js');
  expect(paths.pathResolver.rootDir()).toBe(root);
  expect(paths.pathResolver.primaryCheckoutRootDir()).toBe(root);
  encryption.overrideSecretEncryptionKeyForTests(Buffer.alloc(32, 19));
  const tenants = await import('../organization/tenant-registry.js');
  authority.withExecutionContext('ecosystem_architect', () =>
    tenants.writeTenantProfile(
      {
        tenant_slug: tenant,
        display_name: 'Synthetic account runtime tenant',
        status: 'active',
        assigned_role: 'worker',
      },
      { rootDir: root }
    )
  );
  const bindings = await import('../service/service-binding-registry.js');
  authority.withExecutionContext('sovereign_concierge', () =>
    io.withSensitivePathMediation(() => {
      bindings.saveServiceBindingRecord(selected);
      reference = storage.storeLocalAccountMaterial(
        {
          serviceId: 'slack',
          bindingId: selected.binding_id,
          ownerKind: 'person',
          ownerRef: 'user:owner',
        },
        { SLACK_TOKEN: 'synthetic-encrypted-account-token' }
      );
      storage.storeLocalAccountRegistration(reference, { generation: reference.generation });
      const directory = paths.pathResolver.rootResolve(
        `knowledge/personal/connections/accounts/${storage.localAccountMaterialAccountId(reference)}`
      );
      for (const name of io.safeReaddir(directory)) {
        expect(
          String(io.safeReadFile(path.join(directory, name), { encoding: 'utf8' }))
        ).not.toContain('synthetic-encrypted-account-token');
      }
    })
  );
  resolver.resetSecretResolver();
  allocations.installLocalCredentialAllocations();
  scopes.resetScopeEnvelopeState();
  coordination.setWorkCoordinationNamespace(`vitest-account-runtime-${randomUUID()}`);
}, 60000);

afterAll(async () => {
  // Resolve deferred denial-audit imports while the sink is still isolated.
  await import('../governance/audit-chain.js');
  encryption?.overrideSecretEncryptionKeyForTests(null);
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

describe('personal encrypted account through real claimed worker dispatch', () => {
  it('reads only under allocation authority, retains organization identity and revokes on next use', async () => {
    const item = coordination.createWorkItem({
      title: 'Encrypted account dispatch',
      description: 'Synthetic fixture',
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
    const parent = scopes.mintScopeEnvelope({
      env: {
        KYBERION_TIER: 'confidential',
        KYBERION_TENANT: tenant,
        KYBERION_ORGANIZATION_ID: organization,
        KYBERION_PROJECT_ID: project,
        MISSION_ID: mission,
      },
      policy: { purpose: 'synthetic account dispatch' },
    });
    const port = new portModule.CoordinatedAgentExecutionPort(
      {
        delegate: async (request) => {
          expect(authority.resolveRole()).toBe('chronos_gateway');
          expect(actors.currentActor()).toMatchObject({
            actor: { id: actorId },
            provenance: 'claim',
          });
          expect(scopes.currentScopeEnvelope()?.identity.organization_id).toBe(organization);
          expect(coordination.getWorkItem(item.item_id)?.claimed_by_peer_id).toBe(actorId);
          expect(() => storage.loadLocalAccountMaterial(reference)).toThrow(
            'Local operator storage only'
          );
          expect(() => storage.loadAllocatedLocalAccountMaterial(reference)).toThrow('admission');
          expect(() =>
            io.withSensitivePathMediation(() =>
              io.safeReadFile(
                paths.pathResolver.rootResolve(
                  `knowledge/personal/connections/accounts/${storage.localAccountMaterialAccountId(reference)}/${reference.generation}.json`
                ),
                { encoding: 'utf8' }
              )
            )
          ).toThrow();
          expect(credentials.resolveTaskCredential('SLACK_TOKEN')).toBeNull();
          const expected = {
            serviceBindingId: selected.binding_id,
            serviceId: 'slack',
            sourceOwnerRef: 'user:owner',
            allocationGrantId: 'GRT-ACCOUNT-FIXTURE',
          };
          expect(credentials.resolveTaskServiceCredential('SLACK_TOKEN', expected)).toBe(
            'synthetic-encrypted-account-token'
          );
          state.revoked = true;
          expect(() => credentials.resolveTaskServiceCredential('SLACK_TOKEN', expected)).toThrow(
            'ALLOCATION_DENIED'
          );
          state.revoked = false;
          return {
            execution_kind: 'agent_delegation',
            task_id: request.task_id,
            agent_id: actorId,
            status: 'succeeded',
          };
        },
      },
      actorId
    );
    const receipt = await authority.withExecutionContext(
      'chronos_gateway',
      () =>
        scopes.withScopeEnvelope(parent, () =>
          port.delegate({
            work_item_id: item.item_id,
            task_id: task,
            mission_id: mission,
            instruction: 'Synthetic account check',
            security_scope: {
              tenant_slug: tenant,
              organization_id: organization,
              project_id: project,
              mission_id: mission,
              read_tiers: ['confidential'],
              write_tier: 'confidential',
              purpose: 'synthetic account dispatch',
            },
          })
        ),
      'worker',
      tenant,
      organization,
      { missionId: mission, taskId: task }
    );
    expect(receipt.status).toBe('succeeded');
    expect(coordination.getWorkItem(item.item_id)?.status).toBe('done');
    expect(coordination.listActiveWorkLeases()).toHaveLength(0);
    expect(credentials.resolveTaskCredential('SLACK_TOKEN')).toBeUndefined();
  });
});
