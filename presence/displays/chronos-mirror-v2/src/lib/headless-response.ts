import {
  buildChronosHeadlessManifest,
  createHeadlessEnvelope,
  filterHeadlessManifestForViewer,
  type HeadlessApiManifest,
} from '@agent/core/headless-surface-contract';
import type { ViewerContext } from './viewer-context';
import {
  toSurfaceAuthorizationContext,
  viewerErrorResponse,
  ViewerContextError,
} from './viewer-context';
import { headlessViewerScope, HeadlessQueryError } from './headless-projections';
import { authorizeSurfaceOperation } from '@agent/core/surface-authorization';

export function headlessManifest(): HeadlessApiManifest {
  return buildChronosHeadlessManifest();
}

export function headlessManifestForViewer(viewer: ViewerContext): HeadlessApiManifest {
  return filterHeadlessManifestForViewer(toSurfaceAuthorizationContext(viewer), headlessManifest());
}

export function authorizeHeadlessOperation(
  viewer: ViewerContext,
  operationId: string,
  resource?: { tenantSlug?: string; organizationId?: string; projectId?: string; tier?: string }
): void {
  const operation = headlessManifest().operations.find(
    (candidate) => candidate.operation_id === operationId
  );
  if (!operation) throw new ViewerContextError(403, `unknown headless operation: ${operationId}`);
  const decision = authorizeSurfaceOperation({
    context: toSurfaceAuthorizationContext(viewer),
    operation: {
      operationId: operation.operation_id,
      effect: operation.effect,
      requiredRole: operation.required_role,
      requiredPermissions: operation.required_permissions,
    },
    resource,
  });
  if (!decision.allowed) throw new ViewerContextError(403, decision.reason);
}

export function headlessEnvelope<T>(
  resource: string,
  data: T,
  viewer: ViewerContext,
  manifest = headlessManifest()
) {
  return createHeadlessEnvelope({
    resource,
    data,
    scope: headlessViewerScope(viewer),
    manifest,
    authorizationContext: toSurfaceAuthorizationContext(viewer),
  });
}

export function headlessErrorResponse(error: unknown, statusOverride?: number) {
  return viewerErrorResponse(
    error,
    statusOverride ?? (error instanceof HeadlessQueryError ? 400 : undefined)
  );
}

export function parseHeadlessLimit(
  rawValue: string | null,
  defaultValue: number,
  maximum: number
): number {
  if (rawValue === null || rawValue.trim() === '') return defaultValue;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new HeadlessQueryError(`invalid limit: expected an integer from 1 to ${maximum}`);
  }
  return value;
}
