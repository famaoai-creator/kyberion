import { beforeEach, describe, expect, it, vi } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import schema from '../../../knowledge/product/schemas/information-asset-catalog.schema.json';
import definitions from '../../../knowledge/product/orchestration/information-asset-types.json';
const fixture = vi.hoisted(() => ({
  files: new Map<string, string>(),
  revoked: false,
  unsafe: false,
  binding: true,
}));
vi.mock('../foundation/json.js', () => ({
  readJson: (file: string) => JSON.parse(fixture.files.get(file)!),
  writeJson: (file: string, value: unknown) => fixture.files.set(file, JSON.stringify(value)),
}));
vi.mock('../service/service-binding-registry.js', () => ({
  serviceBindingRecordPath: (id: string) => '/repo/bindings/' + id + '.json',
}));
vi.mock('../secure-io.js', () => ({
  safeExistsSync: (file: string) => fixture.files.has(file),
  safeReadFile: (file: string) => fixture.files.get(file),
  safeWriteFile: (file: string, value: string) => fixture.files.set(file, value),
  safeMkdir: () => {},
}));
vi.mock('../path-resolver.js', () => ({
  pathResolver: {
    rootDir: () => '/repo',
    organizationStateDir: () => '/repo/catalog',
    shared: () => '/repo/bindings',
  },
}));
vi.mock('./access.js', () => ({
  assertInformationAssetCatalogAuthorization: () => {},
  assertInformationAssetScope: () => {},
  assertCurrentInformationAssetScope: () => {},
  assertInformationAssetParents: () => {},
  authorizeInformationAssetManagement: async (auth: unknown) => auth,
  withInformationAssetResources: (
    _a: unknown,
    _s: unknown,
    _f: unknown,
    _w: unknown,
    action: () => unknown
  ) => action(),
  assertInformationAssetRegularPath: () => {
    if (fixture.unsafe) throw Error('nonregular');
  },
  assertInformationAssetBinding: () => {
    if (!fixture.binding) throw Error('binding unavailable');
  },
}));
vi.mock('../organization/organization-people-access.js', () => ({
  verifyOrganizationPeople: async () => {
    if (fixture.revoked) throw Error('revoked');
  },
  withOrganizationPeopleMutation: async (action: () => unknown) => action(),
  recordPeopleManagementAudit: async () => {},
}));
vi.mock('../ingest-asset-ledger.js', () => ({
  findAssetBySource: async () => null,
  assetProvenanceRef: () => '',
}));
vi.mock('../organization/organization-operating-model-persistence.js', () => ({
  organizationOperationalStatePath: () => '/repo/org.json',
}));
vi.mock('../project/project-registry.js', () => ({
  projectRecordPath: () => '/repo/project.json',
}));
vi.mock('../foundation/governed-catalog.js', () => ({
  defineCatalog: () => ({
    validate: (value: unknown) => {
      const ajv = new Ajv();
      addFormats(ajv);
      if (!ajv.validate(schema, value)) throw Error('invalid schema');
      return value;
    },
    load: () => definitions,
  }),
}));
import {
  listManagedInformationAssetLocations,
  saveManagedInformationAssetLocation,
  readInformationAssetCatalog,
  resolveInformationAssets,
  resolveManagedInformationAssets,
} from './catalog.js';
import type { InformationAssetLocation } from './types.js';
const scope = { tenant_slug: 'acme', organization_id: 'org-a' };
const auth = {
  actorId: 'human:owner',
  memberId: 'owner',
  tenantSlug: 'acme',
  allowedOrganizationIds: 'all' as const,
  allowedProjectIds: 'all' as const,
};
const location: InformationAssetLocation = {
  location_id: 'mail',
  asset_type: 'customer.request',
  scope,
  binding_id: 'mail-binding',
  service_id: 'gmail',
  collector_id: 'gmail',
  selectors: { query: 'is:unread' },
  tier: 'confidential',
  authoritative: true,
  freshness_seconds: 60,
  enabled: true,
  version: 1,
  updated_at: '2026-11-02T00:00:00Z',
};
describe('organization information asset catalog', () => {
  it('grants coverage reads only for visible location checkpoints', async () => {
    const project = { ...scope, project_id: 'project-a' };
    fixture.files.set(
      '/repo/catalog/information-assets.json',
      JSON.stringify({
        version: 1,
        scope,
        locations: [location, { ...location, location_id: 'project-mail', scope: project }],
      })
    );
    const coverageResources = vi.fn((loc) => [
      `/repo/active/shared/runtime/dot/confidential/acme/organizations/org-a/projects/project-a/information-assets/collections/${loc.location_id}.json`,
    ]);
    const coverage = vi.fn(() => ({
      status: 'complete' as const,
      observed_at: '2026-11-02T00:00:00Z',
      page_count: 1,
      accepted_count: 1,
    }));
    const result = await resolveManagedInformationAssets(
      auth,
      { scope: project, asset_type: 'email', now: '2026-11-02T00:00:30Z' },
      { coverage, coverageResources }
    );
    expect(coverageResources).toHaveBeenCalledTimes(1);
    expect(coverage).toHaveBeenCalledTimes(1);
    expect(result.locations[0]?.current).toBe(true);
    await expect(
      resolveManagedInformationAssets(
        auth,
        { scope: project, asset_type: 'email' },
        { coverageResources: () => ['/repo/knowledge/personal/secret.json'] }
      )
    ).rejects.toThrow('visible location checkpoint');
  });
  beforeEach(() => {
    fixture.files.clear();
    fixture.revoked = false;
    fixture.unsafe = false;
    fixture.binding = true;
  });
  it('publishes with catalog CAS and increments the location version', async () => {
    const first = await saveManagedInformationAssetLocation(auth, {
      scope,
      location,
      expectedVersion: 0,
    });
    expect(first.version).toBe(1);
    await expect(
      saveManagedInformationAssetLocation(auth, { scope, location, expectedVersion: 0 })
    ).rejects.toThrow('changed');
    const second = await saveManagedInformationAssetLocation(auth, {
      scope,
      location,
      expectedVersion: 1,
    });
    expect(second.locations[0]?.version).toBe(2);
  });
  it('reverifies authorization under lock before writing', async () => {
    fixture.revoked = true;
    await expect(
      saveManagedInformationAssetLocation(auth, { scope, location, expectedVersion: 0 })
    ).rejects.toThrow('revoked');
    expect(fixture.files.size).toBe(0);
  });
  it('rejects corrupt schema, foreign scopes, and nonregular storage', () => {
    fixture.files.set('/repo/catalog/information-assets.json', '{}');
    expect(() => readInformationAssetCatalog(scope)).toThrow('invalid schema');
    fixture.files.set(
      '/repo/catalog/information-assets.json',
      JSON.stringify({ version: 1, scope: { ...scope, tenant_slug: 'other' }, locations: [] })
    );
    expect(() => readInformationAssetCatalog(scope)).toThrow('scope mismatch');
    fixture.unsafe = true;
    expect(() => readInformationAssetCatalog(scope)).toThrow('nonregular');
  });
  it('filters project metadata before alias resolution or coverage lookup', async () => {
    const project = { ...scope, project_id: 'project-a' };
    fixture.files.set(
      '/repo/catalog/information-assets.json',
      JSON.stringify({
        version: 1,
        scope,
        locations: [location, { ...location, location_id: 'project-mail', scope: project }],
      })
    );
    const coverage = vi.fn();
    const result = resolveInformationAssets({ scope: project, asset_type: 'email' }, { coverage });
    expect(result.locations.map((item) => item.location.location_id)).toEqual(['project-mail']);
    expect(coverage).toHaveBeenCalledTimes(1);
    const listing = await listManagedInformationAssetLocations(
      { ...auth, allowedProjectIds: [] },
      scope
    );
    expect(listing.locations.map((loc) => loc.location_id)).toEqual(['mail']);
  });
  it('explains unobserved, stale and unavailable sources without binding credentials', async () => {
    await saveManagedInformationAssetLocation(auth, { scope, location, expectedVersion: 0 });
    expect(resolveInformationAssets({ scope, asset_type: 'email' }).locations[0]?.freshness).toBe(
      'unobserved'
    );
    const result = resolveInformationAssets(
      { scope, asset_type: 'email', now: '2026-11-02T01:00:00Z' },
      {
        coverage: () => ({
          status: 'partial',
          observed_at: '2026-11-02T00:00:00Z',
          page_count: 1,
          accepted_count: 1,
        }),
      }
    );
    expect(result.locations[0]?.freshness).toBe('stale');
    fixture.binding = false;
    expect(resolveInformationAssets({ scope, asset_type: 'email' }).status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('secret_refs');
  });
});
