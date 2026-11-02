import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir } from '../secure-io.js';
import { readJson, writeJson } from '../foundation/json.js';
import { serviceBindingRecordPath } from '../service/service-binding-registry.js';
import { PARTITIONED_RUNTIME_STATE_ROOTS } from '../storage-layout.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import {
  fail,
  type SurfaceManagementAuthorization,
} from '../surface/surface-management-contract.js';
import {
  verifyOrganizationPeople,
  withOrganizationPeopleMutation,
  recordPeopleManagementAudit,
} from '../organization/organization-people-access.js';
import { assetProvenanceRef, findAssetBySource } from '../ingest-asset-ledger.js';
import {
  assertInformationAssetScope,
  assertCurrentInformationAssetScope,
  assertInformationAssetParents,
  authorizeInformationAssetManagement,
  withInformationAssetResources,
  assertInformationAssetRegularPath,
  assertInformationAssetBinding,
  type InformationAssetOptions,
} from './access.js';
import type {
  InformationAssetCatalog,
  InformationAssetLocation,
  InformationAssetScope,
  InformationAssetDefinition,
  InformationAssetCoverage,
} from './types.js';
import { organizationOperationalStatePath } from '../organization/organization-operating-model-persistence.js';
import { projectRecordPath } from '../project/project-registry.js';

const schema = () =>
  path.join(
    pathResolver.rootDir(),
    'knowledge/product/schemas/information-asset-catalog.schema.json'
  );
function parentResources(scope: InformationAssetScope, options: InformationAssetOptions): string[] {
  return [
    organizationOperationalStatePath(
      scope.organization_id,
      'confidential',
      scope.tenant_slug,
      options.rootDir
    ),
    ...(scope.project_id ? [projectRecordPath(scope.project_id, options.rootDir)] : []),
  ];
}
export function informationAssetCatalogPath(
  scope: InformationAssetScope,
  options: InformationAssetOptions = {}
): string {
  assertInformationAssetScope(scope);
  return path.join(
    pathResolver.organizationStateDir(
      scope.organization_id,
      'confidential',
      scope.tenant_slug,
      options.rootDir
    ),
    'information-assets.json'
  );
}
function validate(value: unknown): InformationAssetCatalog {
  return defineCatalog<InformationAssetCatalog>({
    id: 'information-assets',
    path: 'unused',
    schema: schema(),
  }).validate(value);
}
function read(
  scope: InformationAssetScope,
  options: InformationAssetOptions
): InformationAssetCatalog {
  const file = informationAssetCatalogPath(scope, options);
  assertInformationAssetRegularPath(file);
  if (!safeExistsSync(file))
    return {
      version: 0,
      scope: { tenant_slug: scope.tenant_slug, organization_id: scope.organization_id },
      locations: [],
    };
  const catalog = validate(readJson<unknown>(file));
  if (
    catalog.scope.tenant_slug !== scope.tenant_slug ||
    catalog.scope.organization_id !== scope.organization_id ||
    catalog.scope.project_id
  )
    fail('invalid_catalog', 409, 'Information asset catalog scope mismatch.');
  const ids = new Set<string>();
  for (const loc of catalog.locations) {
    if (
      ids.has(loc.location_id) ||
      loc.scope.tenant_slug !== scope.tenant_slug ||
      loc.scope.organization_id !== scope.organization_id
    )
      fail(
        'invalid_catalog',
        409,
        'Information asset catalog contains duplicate or foreign locations.'
      );
    ids.add(loc.location_id);
  }
  return catalog;
}
function visible(
  catalog: InformationAssetCatalog,
  scope: InformationAssetScope,
  auth?: SurfaceManagementAuthorization
): InformationAssetCatalog {
  return {
    ...catalog,
    scope: { ...scope },
    locations: catalog.locations.filter((loc) =>
      scope.project_id
        ? loc.scope.project_id === scope.project_id
        : !auth ||
          !loc.scope.project_id ||
          auth.allowedProjectIds === 'all' ||
          auth.allowedProjectIds.includes(loc.scope.project_id)
    ),
  };
}
export function readInformationAssetCatalog(
  scope: InformationAssetScope,
  options: InformationAssetOptions = {}
): InformationAssetCatalog {
  assertCurrentInformationAssetScope(scope);
  assertInformationAssetParents(scope, options);
  return visible(read(scope, options), scope);
}
export async function listManagedInformationAssetLocations(
  auth: SurfaceManagementAuthorization,
  scope: InformationAssetScope,
  options: InformationAssetOptions = {}
) {
  const resolved = await authorizeInformationAssetManagement(auth, scope);
  return withInformationAssetResources(
    resolved,
    scope,
    [informationAssetCatalogPath(scope, options), ...parentResources(scope, options)],
    false,
    () => {
      assertInformationAssetParents(scope, options);
      return visible(read(scope, options), scope, resolved);
    }
  );
}
export async function saveManagedInformationAssetLocation(
  auth: SurfaceManagementAuthorization,
  input: {
    scope: InformationAssetScope;
    location: InformationAssetLocation;
    expectedVersion: number;
  },
  options: InformationAssetOptions = {}
) {
  validate({
    version: 0,
    scope: { tenant_slug: input.scope.tenant_slug, organization_id: input.scope.organization_id },
    locations: [input.location],
  });
  return mutate(
    auth,
    input.scope,
    input.expectedVersion,
    options,
    (catalog) => {
      const loc = input.location;
      if (loc.tier !== 'confidential')
        fail(
          'unsupported_tier',
          400,
          'Personal locations require person-owner authorization and are not yet supported.'
        );
      if (
        loc.scope.tenant_slug !== input.scope.tenant_slug ||
        loc.scope.organization_id !== input.scope.organization_id ||
        loc.scope.project_id !== input.scope.project_id
      )
        fail('invalid_scope', 400, 'Location scope must equal requested scope.');
      withInformationAssetResources(
        auth,
        loc.scope,
        [],
        false,
        () => assertInformationAssetBinding(loc),
        [serviceBindingRecordPath(loc.binding_id)]
      );
      const prior = catalog.locations.find((item) => item.location_id === loc.location_id);
      if (prior && prior.scope.project_id !== input.scope.project_id)
        fail('forbidden', 403, 'Location belongs to another project scope.');
      const next = {
        ...loc,
        version: (prior?.version ?? 0) + 1,
        updated_at: new Date().toISOString(),
      };
      catalog.locations = catalog.locations
        .filter((item) => item.location_id !== loc.location_id)
        .concat(next);
    },
    [serviceBindingRecordPath(input.location.binding_id)]
  );
}
export async function removeManagedInformationAssetLocation(
  auth: SurfaceManagementAuthorization,
  input: { scope: InformationAssetScope; location_id: string; expectedVersion: number },
  options: InformationAssetOptions = {}
) {
  return mutate(auth, input.scope, input.expectedVersion, options, (catalog) => {
    const prior = catalog.locations.find((loc) => loc.location_id === input.location_id);
    if (!prior || (prior.scope.project_id ?? undefined) !== input.scope.project_id)
      fail('not_found', 404, 'Location not found in requested scope.');
    catalog.locations = catalog.locations.filter((loc) => loc.location_id !== input.location_id);
  });
}
async function mutate(
  auth: SurfaceManagementAuthorization,
  scope: InformationAssetScope,
  expectedVersion: number,
  options: InformationAssetOptions,
  change: (catalog: InformationAssetCatalog) => void,
  additionalReads: string[] = []
) {
  const resolved = await authorizeInformationAssetManagement(auth, scope, true);
  return withOrganizationPeopleMutation(async () => {
    await verifyOrganizationPeople(resolved);
    withInformationAssetResources(resolved, scope, parentResources(scope, options), false, () =>
      assertInformationAssetParents(scope, options)
    );
    const file = informationAssetCatalogPath(scope, options);
    const result = withInformationAssetResources(
      resolved,
      scope,
      [file],
      true,
      () => {
        const catalog = read(scope, options);
        if (catalog.version !== expectedVersion)
          fail('version_conflict', 409, 'Information asset catalog changed. Refresh and retry.');
        change(catalog);
        catalog.version++;
        validate(catalog);
        assertInformationAssetRegularPath(file);
        safeMkdir(path.dirname(file), { recursive: true });
        writeJson(file, catalog);
        return visible(catalog, scope, resolved);
      },
      additionalReads
    );
    await recordPeopleManagementAudit(resolved, 'information-assets', 'update', {
      organization_id: scope.organization_id,
      version: result.version,
    });
    return result;
  });
}
export function loadInformationAssetDefinitions(): InformationAssetDefinition[] {
  return defineCatalog<InformationAssetDefinition[]>({
    id: 'information-asset-types',
    path: path.join(
      pathResolver.rootDir(),
      'knowledge/product/orchestration/information-asset-types.json'
    ),
    schema: path.join(
      pathResolver.rootDir(),
      'knowledge/product/schemas/information-asset-types.schema.json'
    ),
  }).load();
}
export interface InformationAssetResolveOptions extends InformationAssetOptions {
  coverage?: (location: InformationAssetLocation) => InformationAssetCoverage | undefined;
  /** Exact checkpoint reads for the trusted coverage port; called only for visible locations. */
  coverageResources?: (location: InformationAssetLocation) => readonly string[];
}
export async function resolveManagedInformationAssets(
  auth: SurfaceManagementAuthorization,
  input: Parameters<typeof resolveInformationAssets>[0],
  options: InformationAssetResolveOptions = {}
) {
  const resolved = await authorizeInformationAssetManagement(auth, input.scope);
  const catalog = await listManagedInformationAssetLocations(resolved, input.scope, options);
  const files = [
    informationAssetCatalogPath(input.scope, options),
    organizationOperationalStatePath(
      input.scope.organization_id,
      'confidential',
      input.scope.tenant_slug,
      options.rootDir
    ),
    ...(input.scope.project_id ? [projectRecordPath(input.scope.project_id, options.rootDir)] : []),
    ...catalog.locations.map((loc) => serviceBindingRecordPath(loc.binding_id)),
    ...catalog.locations.flatMap((loc) => {
      const expected = path.resolve(
        options.rootDir ?? pathResolver.rootDir(),
        PARTITIONED_RUNTIME_STATE_ROOTS.dot,
        'confidential',
        loc.scope.tenant_slug,
        'organizations',
        loc.scope.organization_id,
        ...(loc.scope.project_id ? ['projects', loc.scope.project_id] : []),
        'information-assets/collections',
        `${loc.location_id}.json`
      );
      return [...(options.coverageResources?.(loc) ?? [])].map((file) => {
        if (path.resolve(file) !== expected)
          fail(
            'invalid_coverage_resource',
            400,
            'Coverage capability must name this visible location checkpoint.'
          );
        return file;
      });
    }),
  ];
  return withInformationAssetResources(resolved, input.scope, files, false, () => {
    assertInformationAssetParents(input.scope, options);
    return resolveFromCatalog(input, options, catalog);
  });
}
export function resolveInformationAssets(
  input: {
    scope: InformationAssetScope;
    asset_type: string;
    now?: string;
    max_age_seconds?: number;
    require_authoritative?: boolean;
  },
  options: InformationAssetResolveOptions = {}
) {
  const catalog = readInformationAssetCatalog(input.scope, options);
  return resolveFromCatalog(input, options, catalog);
}
function resolveFromCatalog(
  input: Parameters<typeof resolveInformationAssets>[0],
  options: InformationAssetResolveOptions,
  catalog: InformationAssetCatalog
) {
  const matches = loadInformationAssetDefinitions().filter(
    (def) => def.asset_type === input.asset_type || def.aliases.includes(input.asset_type)
  );
  if (matches.length !== 1)
    return {
      status: matches.length ? 'ambiguous' : 'not_found',
      asset_type: input.asset_type,
      scope: input.scope,
      locations: [],
    };
  const asset_type = matches[0]!.asset_type;
  const locations = catalog.locations
    .filter(
      (loc) => loc.asset_type === asset_type && (!input.require_authoritative || loc.authoritative)
    )
    .map((location) => {
      let connected = true;
      try {
        assertInformationAssetBinding(location);
      } catch {
        connected = false;
      }
      const coverage = options.coverage?.(location);
      const age = coverage
        ? (Date.parse(input.now ?? new Date().toISOString()) - Date.parse(coverage.observed_at)) /
          1000
        : undefined;
      const freshness = !coverage
        ? 'unobserved'
        : !Number.isFinite(age) || (age as number) < 0
          ? 'unknown'
          : (age as number) > (input.max_age_seconds ?? location.freshness_seconds)
            ? 'stale'
            : 'fresh';
      return {
        location,
        connected,
        coverage,
        freshness,
        available: location.enabled && connected,
        current:
          location.enabled && connected && freshness === 'fresh' && coverage?.status === 'complete',
        readiness: !location.enabled
          ? 'disabled'
          : !connected
            ? 'binding_unavailable'
            : !coverage
              ? 'unobserved'
              : coverage.status !== 'complete'
                ? coverage.status
                : freshness,
      };
    })
    .sort(
      (a, b) =>
        Number(b.location.authoritative) - Number(a.location.authoritative) ||
        a.location.location_id.localeCompare(b.location.location_id)
    );
  return {
    status: locations.some((loc) => loc.available)
      ? 'resolved'
      : locations.length
        ? 'unavailable'
        : 'not_found',
    asset_type,
    scope: input.scope,
    locations,
  };
}
export async function authorizeInformationAssetCapture(
  scope: InformationAssetScope,
  locationId: string,
  operation: string,
  options: InformationAssetOptions = {}
): Promise<InformationAssetLocation> {
  const location = readInformationAssetCatalog(scope, options).locations.find(
    (loc) => loc.location_id === locationId
  );
  if (!location || !location.enabled)
    fail('not_found', 404, 'Enabled information asset location not found.');
  assertInformationAssetBinding(location, operation);
  return location;
}
/** Only committed ingest ledger entries produce provenance; discovery never creates one. */
export function informationAssetIngestProjection(
  scope: InformationAssetScope,
  sourceSystem: string,
  sourceId: string,
  options: InformationAssetOptions = {}
) {
  assertCurrentInformationAssetScope(scope);
  assertInformationAssetParents(scope, options);
  const record = findAssetBySource(scope.tenant_slug, sourceSystem, sourceId, options);
  return record
    ? {
        source_system: sourceSystem,
        source_id: sourceId,
        source_version: record.source_version,
        version: record.version,
        assetProvenanceRef: assetProvenanceRef(record),
      }
    : null;
}
