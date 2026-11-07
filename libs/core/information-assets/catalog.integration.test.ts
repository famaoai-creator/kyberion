import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext as initialContext } from '../authority.js';
import { rootDir } from '../path-resolver.js';
import * as initialIO from '../secure-io.js';
import type { InformationAssetLocation } from './types.js';

const SOURCE = rootDir();
const ROOT = path.join(SOURCE, 'active/shared/tmp/information-catalog-integration-' + process.pid);
const keys = [
  'KYBERION_ROOT',
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'MISSION_ID',
  'KYBERION_TENANT',
  'KYBERION_SUDO',
  'KYBERION_SUDO_SCOPE',
  'KYBERION_AGENT_TIER',
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
let io = initialIO;
let context = initialContext;
let catalog: typeof import('./catalog.js');
let resolver: typeof import('../path-resolver.js');
const privileged = <T>(fn: () => T) => context('sovereign_concierge', fn);
const scope = { tenant_slug: 'assets-acme', organization_id: 'assets-org' };
const auth = {
  actorId: 'user:assets-owner',
  memberId: 'assets-owner',
  tenantSlug: scope.tenant_slug,
  allowedOrganizationIds: 'all' as const,
  allowedProjectIds: 'all' as const,
};
const now = '2026-11-02T00:00:00Z';
const location: InformationAssetLocation = {
  location_id: 'requests',
  asset_type: 'customer.request',
  scope,
  binding_id: 'assets-mail',
  service_id: 'gmail',
  collector_id: 'gmail',
  selectors: { query: 'is:unread' },
  tier: 'confidential',
  authoritative: true,
  freshness_seconds: 3600,
  enabled: true,
  version: 1,
  updated_at: now,
};
function provision() {
  initialContext('ecosystem_architect', () => {
    initialIO.safeRmSync(ROOT, { recursive: true, force: true });
    initialIO.safeWriteFile(path.join(ROOT, 'package.json'), '{"name":"information-assets-test"}');
    const copy = (relative: string) => {
      initialIO.safeMkdir(path.join(ROOT, relative), { recursive: true });
      for (const name of initialIO.safeReaddir(path.join(SOURCE, relative))) {
        const file = path.join(relative, name);
        const stat = initialIO.safeLstat(path.join(SOURCE, file));
        if (stat.isSymbolicLink()) throw Error('Linked governance fixture');
        if (stat.isDirectory()) copy(file);
        else if (/\.(json|yaml)$/.test(name))
          initialIO.safeCopyFileSync(path.join(SOURCE, file), path.join(ROOT, file));
      }
    };
    copy('knowledge/product/governance');
    copy('knowledge/product/schemas');
    const types = 'knowledge/product/orchestration/information-asset-types.json';
    initialIO.safeMkdir(path.join(ROOT, path.dirname(types)), { recursive: true });
    initialIO.safeCopyFileSync(path.join(SOURCE, types), path.join(ROOT, types));
  });
}
beforeAll(async () => {
  provision();
  process.env.KYBERION_ROOT = ROOT;
  vi.resetModules();
  io = await import('../secure-io.js');
  ({ withExecutionContext: context } = await import('../authority.js'));
  resolver = await import('../path-resolver.js');
  catalog = await import('./catalog.js');
}, 30000);
beforeEach(() => {
  for (const key of keys) if (key !== 'KYBERION_ROOT') delete process.env[key];
  privileged(() => {
    io.safeRmSync(path.join(ROOT, 'active'), { recursive: true, force: true });
    const write = (file: string, value: unknown) =>
      io.safeWriteFile(path.join(ROOT, file), JSON.stringify(value));
    write('knowledge/personal/members/assets-owner.json', {
      member_id: 'assets-owner',
      display_name: 'Owner',
      status: 'active',
      memberships: [{ tenant_slug: scope.tenant_slug, role: 'owner' }],
      access_registrations: [],
      created_at: now,
      updated_at: now,
    });
    write('knowledge/personal/tenants/assets-acme.json', {
      tenant_slug: scope.tenant_slug,
      display_name: 'Acme',
      status: 'active',
      assigned_role: 'owner',
    });
    write(
      'active/organizations/confidential/assets-acme/assets-org/state/organization-state.json',
      {
        organization_id: scope.organization_id,
        name: 'Assets',
        tier: 'confidential',
        tenant_slug: scope.tenant_slug,
        status: 'active',
        updated_at: now,
      }
    );
    write('active/shared/runtime/projects/assets-project.json', {
      project_id: 'assets-project',
      name: 'Project',
      summary: 'Fixture',
      status: 'active',
      tier: 'confidential',
      tenant_slug: scope.tenant_slug,
      organization_id: scope.organization_id,
    });
    write('active/shared/runtime/service-bindings/assets-mail.json', {
      binding_id: 'assets-mail',
      service_type: 'gmail',
      scope: 'tenant',
      target: 'mailbox',
      allowed_actions: ['gmail_messages_list'],
      secret_refs: ['secret:test-mail'],
      approval_policy: { gmail_messages_list: 'allowed' },
      tenant_slug: scope.tenant_slug,
      owner_kind: 'organization',
      owner_ref: scope.tenant_slug,
      service_id: 'gmail',
    });
  });
});
afterAll(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  initialContext('ecosystem_architect', () =>
    initialIO.safeRmSync(ROOT, { recursive: true, force: true })
  );
});
describe('catalog real governed IO', () => {
  it('binds a project checkpoint to the canonical active project and exact project capability', async () => {
    const projectScope = { ...scope, project_id: 'assets-project' };
    privileged(() => {
      const file = path.join(ROOT, 'active/shared/runtime/service-bindings/assets-mail.json');
      const binding = JSON.parse(io.safeReadFile(file, { encoding: 'utf8' }) as string);
      binding.project_id = projectScope.project_id;
      io.safeWriteFile(file, JSON.stringify(binding));
    });
    await catalog.saveManagedInformationAssetLocation(auth, {
      scope: projectScope,
      location: { ...location, scope: projectScope },
      expectedVersion: 0,
    });
    const registered = (await catalog.listManagedInformationAssetLocations(auth, projectScope))
      .locations[0]!;
    const {
      informationAssetCollectionStatePath,
      readInformationAssetCollectionCoverage,
      canonicalInformationJson,
    } = await import('./collector.js');
    privileged(() =>
      io.safeWriteFile(
        informationAssetCollectionStatePath(registered),
        JSON.stringify({
          version: 1,
          identity: createHash('sha256')
            .update(canonicalInformationJson({ location: registered, adapter_version: 1 }))
            .digest('hex'),
          cursor: {},
          coverage: { status: 'complete', observed_at: now, page_count: 1, accepted_count: 1 },
        })
      )
    );
    const result = await catalog.resolveManagedInformationAssets(
      auth,
      { scope: projectScope, asset_type: 'email', now },
      {
        coverage: readInformationAssetCollectionCoverage,
        coverageResources: (loc) => [informationAssetCollectionStatePath(loc)],
      }
    );
    expect(result.locations[0]?.current).toBe(true);
  });
  it('reads persisted coverage under an exact read-only checkpoint capability', async () => {
    await catalog.saveManagedInformationAssetLocation(auth, {
      scope,
      location,
      expectedVersion: 0,
    });
    const registered = (await catalog.listManagedInformationAssetLocations(auth, scope))
      .locations[0]!;
    const {
      informationAssetCollectionStatePath,
      readInformationAssetCollectionCoverage,
      canonicalInformationJson,
    } = await import('./collector.js');
    const file = informationAssetCollectionStatePath(registered);
    privileged(() =>
      io.safeWriteFile(
        file,
        JSON.stringify({
          version: 1,
          identity: createHash('sha256')
            .update(canonicalInformationJson({ location: registered, adapter_version: 1 }))
            .digest('hex'),
          cursor: {},
          coverage: { status: 'complete', observed_at: now, page_count: 2, accepted_count: 3 },
        })
      )
    );
    const result = await catalog.resolveManagedInformationAssets(
      auth,
      { scope, asset_type: 'email', now },
      {
        coverage: readInformationAssetCollectionCoverage,
        coverageResources: (loc) => [informationAssetCollectionStatePath(loc)],
      }
    );
    expect(result.locations[0]).toMatchObject({
      current: true,
      freshness: 'fresh',
      coverage: { status: 'complete', page_count: 2, accepted_count: 3 },
    });
    const { collectInformationAssets } =
      await import('../../../presence/displays/concierge/src/lib/ops/information-assets.js');
    const projected = collectInformationAssets(
      {
        role: 'readonly',
        source: 'token',
        principalId: 'user:assets-owner',
        memberId: 'assets-owner',
        tenantSlugs: [scope.tenant_slug],
        organizationIds: [scope.organization_id],
        projectIds: 'all',
        tierAccess: ['confidential'],
      },
      { ...scope, tier: 'confidential' }
    );
    expect(projected.locations[0]?.coverage).toMatchObject({
      status: 'complete',
      accepted_count: 3,
    });
    const observation = path.join(path.dirname(file), 'observations', 'private.json');
    const foreign = file.replace('/organizations/assets-org/', '/organizations/other-org/');
    const project = file.replace(
      '/information-assets/',
      '/projects/assets-project/information-assets/'
    );
    privileged(() => {
      for (const target of [observation, foreign, project]) io.safeWriteFile(target, 'private');
    });
    const { runInResourceAccessScope } = await import('../foundation/resource-access-scope.js');
    const relative = (target: string) => path.relative(ROOT, target).split(path.sep).join('/');
    const { withConciergeManagementAccess } =
      await import('../surface/concierge-management-access.js');
    const reads = [file, observation, foreign, project].map(relative);
    const checks = () => {
      expect(() => io.safeReadFile(file, { encoding: 'utf8' })).not.toThrow();
      for (const target of [observation, foreign, project])
        expect(() => io.safeReadFile(target, { encoding: 'utf8' })).toThrow();
      expect(() => io.safeWriteFile(file, 'overwrite')).toThrow();
    };
    // G2: the Concierge management reader is its live grant, opened by the governed facade.
    withConciergeManagementAccess(
      {
        tenantSlug: scope.tenant_slug,
        organizationId: scope.organization_id,
        reads,
        writes: [],
        mkdir: [],
        identity: { projectId: null },
      },
      checks
    );
    for (const role of ['chronos_operator', 'chronos_localadmin'])
      runInResourceAccessScope(
        {
          tenantSlug: scope.tenant_slug,
          organizationId: scope.organization_id,
          readExact: reads,
          writeExact: [],
          mkdirExact: [],
        },
        () =>
          context(role, checks, undefined, scope.tenant_slug, scope.organization_id, {
            projectId: null,
          })
      );
  });
  it('registers a tenant binding with exact capability and CAS under concurrent mutation', async () => {
    const results = await Promise.allSettled([
      catalog.saveManagedInformationAssetLocation(auth, { scope, location, expectedVersion: 0 }),
      catalog.saveManagedInformationAssetLocation(auth, { scope, location, expectedVersion: 0 }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
      results
        .map((result) => (result.status === 'rejected' ? String(result.reason) : 'ok'))
        .join('\n')
    ).toHaveLength(1);
    const stored = await catalog.listManagedInformationAssetLocations(auth, scope);
    expect(stored.version).toBe(1);
    expect(stored.locations[0]?.binding_id).toBe('assets-mail');
    const resolved = await catalog.resolveManagedInformationAssets(auth, {
      scope,
      asset_type: 'email',
    });
    expect(resolved.locations[0]).toMatchObject({
      connected: true,
      freshness: 'unobserved',
      available: true,
      current: false,
    });
    const capture = () =>
      context(
        'organization_operator',
        () =>
          catalog.authorizeInformationAssetCapture(
            scope,
            location.location_id,
            'gmail_messages_list'
          ),
        undefined,
        scope.tenant_slug,
        scope.organization_id
      );
    expect((await capture()).binding_id).toBe('assets-mail');
    privileged(() => {
      const file = path.join(ROOT, 'active/shared/runtime/service-bindings/assets-mail.json');
      const binding = JSON.parse(io.safeReadFile(file, { encoding: 'utf8' }) as string);
      binding.approval_policy.gmail_messages_list = 'denied';
      io.safeWriteFile(file, JSON.stringify(binding));
    });
    await expect(capture()).rejects.toThrow('not explicitly allowed');
  });
  it('rejects cross-tenant parents, project lineage, and suspended owner', async () => {
    await expect(
      catalog.saveManagedInformationAssetLocation(auth, {
        scope: { ...scope, tenant_slug: 'other-tenant' },
        location,
        expectedVersion: 0,
      })
    ).rejects.toThrow();
    const projectScope = { ...scope, project_id: 'assets-project' };
    privileged(() => {
      const file = path.join(ROOT, 'active/shared/runtime/projects/assets-project.json');
      const project = JSON.parse(io.safeReadFile(file, { encoding: 'utf8' }) as string);
      project.organization_id = 'foreign-org';
      io.safeWriteFile(file, JSON.stringify(project));
    });
    await expect(
      catalog.saveManagedInformationAssetLocation(auth, {
        scope: projectScope,
        location: { ...location, scope: projectScope },
        expectedVersion: 0,
      })
    ).rejects.toThrow();
    privileged(() => {
      const file = path.join(ROOT, 'knowledge/personal/members/assets-owner.json');
      const member = JSON.parse(io.safeReadFile(file, { encoding: 'utf8' }) as string);
      member.status = 'suspended';
      io.safeWriteFile(file, JSON.stringify(member));
    });
    await expect(catalog.listManagedInformationAssetLocations(auth, scope)).rejects.toThrow();
  });
  it('rejects symlink catalog and mismatched active execution scope', async () => {
    const file = catalog.informationAssetCatalogPath(scope);
    privileged(() => {
      io.safeMkdir(path.dirname(file), { recursive: true });
      const target = path.join(ROOT, 'active/shared/tmp/catalog.json');
      io.safeWriteFile(target, JSON.stringify({ version: 0, scope, locations: [] }));
      io.safeSymlinkSync(target, file);
    });
    await expect(catalog.listManagedInformationAssetLocations(auth, scope)).rejects.toThrow();
    context(
      'organization_operator',
      () =>
        expect(() =>
          catalog.readInformationAssetCatalog({ ...scope, organization_id: 'foreign-org' })
        ).toThrow(),
      undefined,
      scope.tenant_slug,
      scope.organization_id
    );
    expect(resolver.rootDir()).toBe(ROOT);
  });
});
