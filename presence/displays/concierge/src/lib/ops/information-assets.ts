import * as path from 'node:path';
import {
  readInformationAssetCollectionCoverage,
  informationAssetCollectionStatePath,
} from '@agent/core/information-assets/collector';
import { pathResolver } from '@agent/core/path-resolver';
import { runInResourceAccessScope } from '@agent/core/foundation/resource-access-scope';
import { withExecutionContext } from '@agent/core/authority';
import {
  readInformationAssetCatalog,
  loadInformationAssetDefinitions,
} from '@agent/core/information-assets/catalog';
import { authorizeSurfaceContextOperation } from '@agent/core/surface/surface-authn';
import { subjectAuthorization } from '@agent/core/foundation/authorization-registry';
import type { WorkspaceSelection } from '@agent/core/surface/workspace-scope';
import { resolveChronosWorkspace } from './workspace-scope';
import {
  ViewerContextError,
  toSurfaceAuthorizationContext,
  type ViewerContext,
} from './ops-viewer';

/** Resolve viewer scope before reading or counting any catalog entries. */
export function collectInformationAssets(viewer: ViewerContext, requested: WorkspaceSelection) {
  const declaration = subjectAuthorization('chronos.information-assets.read');
  if (
    !declaration.declared ||
    declaration.source !== 'code' ||
    declaration.effectClass !== 'local_only' ||
    declaration.authority.kind !== 'free'
  )
    throw new ViewerContextError(
      403,
      'Information source viewer requires its declared authority path.'
    );
  const workspace = resolveChronosWorkspace(viewer, requested);
  const s = workspace.selection;
  if (!s.tenant_slug || !s.organization_id || s.tier !== 'confidential')
    throw new ViewerContextError(403, 'Select a confidential tenant and organization.');
  if (viewer.projectIds !== 'all' && !s.project_id)
    throw new ViewerContextError(403, 'Select an authorized project.');
  const allowed = authorizeSurfaceContextOperation({
    context: toSurfaceAuthorizationContext(viewer),
    operation: {
      operationId: 'chronos.information-assets.read',
      effect: 'read',
      requiredRole: 'readonly',
      requiredPermissions: ['surface.headless.read'],
    },
    resource: {
      tenantSlug: s.tenant_slug,
      organizationId: s.organization_id,
      projectId: s.project_id,
      tier: s.tier,
    },
    surface: 'chronos',
  });
  if (!allowed.allowed) throw new ViewerContextError(403, allowed.reason);
  const snapshot = withExecutionContext(
    viewer.role === 'localadmin' ? 'chronos_localadmin' : 'chronos_operator',
    () => {
      const catalog = readInformationAssetCatalog({
        tenant_slug: s.tenant_slug!,
        organization_id: s.organization_id!,
        ...(s.project_id ? { project_id: s.project_id } : {}),
      });
      const readExact = catalog.locations.map((location) => {
        const file = informationAssetCollectionStatePath(location);
        const relative = path.relative(pathResolver.rootDir(), file).split(path.sep).join('/');
        if (!relative || relative.startsWith('../') || path.isAbsolute(relative))
          throw new ViewerContextError(403, 'Information source checkpoint outside repository.');
        return relative;
      });
      const coverage = runInResourceAccessScope(
        {
          tenantSlug: s.tenant_slug!,
          organizationId: s.organization_id!,
          ...(s.project_id ? { projectId: s.project_id } : {}),
          readExact,
          metadataExact: readExact,
          writeExact: [],
          mkdirExact: [],
        },
        () =>
          new Map(
            catalog.locations.map((location) => [
              location.location_id,
              readInformationAssetCollectionCoverage(location),
            ])
          )
      );
      return { catalog, coverage };
    },
    undefined,
    s.tenant_slug,
    s.organization_id,
    { projectId: s.project_id ?? null, missionId: null }
  );
  const { catalog, coverage } = snapshot;
  const definitions = loadInformationAssetDefinitions();
  return {
    ok: true as const,
    selection: s,
    version: catalog.version,
    generatedAt: new Date().toISOString(),
    locations: catalog.locations.map((location) => ({
      id: location.location_id,
      assetType: location.asset_type,
      title:
        definitions.find((def) => def.asset_type === location.asset_type)?.title ??
        location.asset_type,
      serviceId: location.service_id,
      collectorId: location.collector_id,
      enabled: location.enabled,
      authoritative: location.authoritative,
      coverage: coverage.get(location.location_id),
      freshnessSeconds: location.freshness_seconds,
      updatedAt: location.updated_at,
      projectId: location.scope.project_id,
    })),
  };
}
export type InformationAssetsData = ReturnType<typeof collectInformationAssets>;
