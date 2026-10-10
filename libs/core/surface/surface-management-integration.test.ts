import { computeAuditEntryHash, GENESIS_HASH } from '../chain-integrity.js';
import { humanActor } from '../actor.js';
import { readTextFile } from '../foundation/text.js';
import { withExecutionContextAsync } from '../authority.js';
import { runInExecutionScope } from '../foundation/execution-scope.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { auditChain } from '../governance/audit-chain.js';
import { executeSurfaceManagementMutation } from './surface-management-mutations.js';
import { safeExistsSync, safeRmSync, safeWriteFile } from '../secure-io.js';
import { writeTenantProfile, tenantProfilePath } from '../organization/tenant-registry.js';
import { writeMemberProfile, memberProfilePath } from '../organization/member-registry.js';
import { projectRecordPath } from '../project/project-registry.js';

// Only redirect audit storage to a private Vitest namespace. Lock, audit, HMAC,
// authority and every filesystem operation use their real implementations.
vi.mock('../path-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../path-resolver.js')>();
  const vitestLivePath = (file: string) =>
    actual
      .vitestLivePath(file)
      .replace(/(vitest-live[/\\]pool-[^/\\]+)/, '$1-management-integration');
  return { ...actual, vitestLivePath, pathResolver: { ...actual.pathResolver, vitestLivePath } };
});
const tenant = 'tenant-management-integ-test';
const member = 'management-integ-owner-test';
const auth = {
  actorId: 'user:' + member,
  memberId: member,
  tenantSlug: tenant,
  allowedOrganizationIds: 'all' as const,
  allowedProjectIds: 'all' as const,
};
const auditDir = pathResolver.vitestLivePath(pathResolver.rootResolve('active/shared/logs/audit'));
let projectId: string | undefined;
function clean(): void {
  if (projectId) safeRmSync(projectRecordPath(projectId), { force: true });
  for (const prefix of [
    'active/organizations/confidential/',
    'active/projects/confidential/',
    'active/shared/runtime/surface-management/confidential/',
    'knowledge/confidential/',
  ])
    safeRmSync(pathResolver.rootResolve(prefix + tenant), { force: true, recursive: true });
  safeRmSync(memberProfilePath(member), { force: true });
  safeRmSync(tenantProfilePath(tenant), { force: true });
  safeRmSync(auditDir, { force: true, recursive: true });
}
beforeEach(() => {
  vi.stubEnv('KYBERION_SUDO', 'true');
  vi.stubEnv('KYBERION_PERSONA', 'sovereign');
  vi.stubEnv('SYSTEM_ROLE', '');
  vi.stubEnv('MISSION_ROLE', '');
  vi.stubEnv('KYBERION_TENANT', tenant);
  vi.stubEnv('KYBERION_ENTITY_GOVERNANCE', 'enforce');
  // Known fixture-only HMAC input. Never read or generate an operator credential.
  vi.stubEnv('KYBERION_AUDIT_CHAIN_KEY', 'surface-management-integration-public-fixture-key');
  clean();
  writeTenantProfile({
    tenant_slug: tenant,
    display_name: 'Integration fixture',
    status: 'active',
    assigned_role: 'customer',
  });
  writeMemberProfile({
    member_id: member,
    display_name: 'Fixture owner',
    status: 'active',
    memberships: [{ tenant_slug: tenant, role: 'owner' }],
    access_registrations: [],
    created_at: '2026-10-10T00:00:00Z',
    updated_at: '2026-10-10T00:00:00Z',
  });
});
afterEach(() => {
  vi.stubEnv('KYBERION_SUDO', 'true');
  vi.stubEnv('SYSTEM_ROLE', '');
  vi.stubEnv('KYBERION_PERSONA', 'sovereign');
  clean();
  vi.unstubAllEnvs();
});
it('persists real scoped actor audit, releases real locks and replays the committed receipt without SUDO', async () => {
  vi.stubEnv('KYBERION_SUDO', 'false');
  vi.stubEnv('KYBERION_PERSONA', '');
  vi.stubEnv('SYSTEM_ROLE', 'concierge');
  vi.stubEnv('KYBERION_TENANT', 'ambient-other-tenant');
  const command = {
    operation: 'organization.create',
    requestId: 'integration-org-001',
    name: 'Integration organization',
    purpose: 'Verify governed writes',
  } as const;
  const org = await executeSurfaceManagementMutation(auth, command);
  expect(org.auditPending).toBeUndefined();
  const project = await executeSurfaceManagementMutation(auth, {
    operation: 'project.create',
    requestId: 'integration-project-001',
    organizationId: org.organizationId,
    name: 'Integration project',
    summary: 'Verify exact links',
  });
  projectId = project.projectId;
  expect(project.auditPending).toBeUndefined();
  const replay = await executeSurfaceManagementMutation(auth, command);
  expect(replay).toMatchObject({ replayed: true, version: org.version });
  expect(replay.auditPending).toBeUndefined();
  const events = auditChain
    .loadAll()
    .filter((entry) => entry.action.startsWith('surface.management.'));
  expect(events).toHaveLength(4);
  expect(events.map((entry) => entry.result)).toEqual([
    'allowed',
    'completed',
    'allowed',
    'completed',
  ]);
  expect(
    events.every(
      (entry) =>
        entry.actor?.kind === 'human' &&
        entry.actor.id === auth.actorId &&
        entry.scope?.tenant_slug === tenant &&
        entry.scope?.organization_id === org.organizationId &&
        entry.scope?.tier === 'confidential'
    )
  ).toBe(true);
  expect(events.slice(2).every((entry) => entry.scope?.project_id === projectId)).toBe(true);
  expect(auditChain.verify()).toMatchObject({ valid: 4, corrupted: [], total: 4 });
  expect(
    safeExistsSync(
      pathResolver.rootResolve('active/shared/runtime/locks/surface-management-mutations.lock')
    )
  ).toBe(false);
  expect(
    safeExistsSync(pathResolver.rootResolve('active/shared/runtime/locks/audit-chain-global.lock'))
  ).toBe(false);
});

it('isolates concurrent audit tenant bindings from the ambient tenant', async () => {
  vi.stubEnv('KYBERION_SUDO', 'false');
  vi.stubEnv('KYBERION_PERSONA', '');
  vi.stubEnv('SYSTEM_ROLE', 'concierge');
  vi.stubEnv('KYBERION_TENANT', 'ambient-other-tenant');
  await Promise.all(
    ['audit-request-alpha', 'audit-request-beta'].map((selected) =>
      withExecutionContextAsync(
        'concierge',
        async () => {
          await Promise.resolve();
          auditChain.record({
            agentId: auth.actorId,
            action: 'test.request-scope',
            operation: 'audit',
            result: 'completed',
            tenantSlug: selected,
          });
        },
        undefined,
        selected
      )
    )
  );
  expect(
    auditChain
      .loadAll()
      .map((entry) => entry.tenantSlug)
      .sort()
  ).toEqual(['audit-request-alpha', 'audit-request-beta']);
  expect(process.env.KYBERION_TENANT).toBe('ambient-other-tenant');
});
it('does not inherit ambient tenant when an explicit tenant-bound scope has no tenant', () => {
  vi.stubEnv('KYBERION_TENANT', 'ambient-other-tenant');
  const entry = runInExecutionScope({ tenantBound: true, assumedRole: 'concierge' }, () =>
    auditChain.record({
      agentId: auth.actorId,
      action: 'test.unbound-scope',
      operation: 'audit',
      result: 'completed',
    })
  );
  expect(entry.tenantSlug).toBeUndefined();
});

it('canonicalizes new actor/scope input order without changing a valid legacy entry', () => {
  const date = new Date().toISOString().slice(0, 10);
  const legacy = {
    id: 'AUD-LEGACY-FIXTURE',
    timestamp: date + 'T00:00:00.000Z',
    agentId: 'legacy-fixture',
    action: 'test.legacy',
    operation: 'test',
    result: 'completed',
    previousHash: GENESIS_HASH,
    currentHash: '',
  };
  legacy.currentHash = computeAuditEntryHash(legacy, GENESIS_HASH);
  const file = auditDir + '/audit-' + date + '.jsonl';
  const line = JSON.stringify(legacy);
  safeWriteFile(file, line + '\n');
  vi.stubEnv('KYBERION_SUDO', 'false');
  vi.stubEnv('KYBERION_PERSONA', '');
  vi.stubEnv('SYSTEM_ROLE', 'concierge');
  const scope = {
    scope_kind: 'tenant' as const,
    tier: 'confidential' as const,
    tenant_slug: tenant,
    organization_id: 'org-audit-fixture',
  };
  auditChain.record({
    actor: humanActor(member),
    scope,
    tenantSlug: tenant,
    result: 'completed',
    operation: 'test',
    agentId: auth.actorId,
    action: 'test.order-a',
  });
  auditChain.record({
    agentId: auth.actorId,
    action: 'test.order-b',
    operation: 'test',
    result: 'completed',
    tenantSlug: tenant,
    scope,
    actor: humanActor(member),
  });
  expect(auditChain.verify()).toMatchObject({ valid: 3, corrupted: [], total: 3 });
  expect(readTextFile(file).split('\n')[0]).toBe(line);
  expect(auditChain.loadAll()[0]?.currentHash).toBe(legacy.currentHash);
});
