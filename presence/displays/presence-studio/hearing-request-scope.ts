import type { Request } from 'express';
import type { SurfaceViewerScope } from '@agent/core/surface/surface-mutation-guard';
import {
  HearingScopeError,
  hearingScopedUrl as hearingScopedUrlForScope,
  resolveHearingHandoffScope as resolveHearingHandoffScopeForViewer,
} from '@agent/core/surface/hearing-scope';
import {
  PresenceStudioViewerError,
  narrowPresenceStudioScope,
  resolvePresenceStudioViewerContext,
  toFrontDeskViewerScope,
  type PresenceStudioViewerContext,
} from './security.js';

export { HearingScopeError };

/** Selection narrows authenticated scope; malformed query values are never absence. */
export function resolveHearingRequestViewer(req: Request): PresenceStudioViewerContext {
  const resolved = resolvePresenceStudioViewerContext(req);
  const selection = (key: 'tenant' | 'organizationId' | 'projectId'): string | undefined => {
    const value = req.query[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string')
      throw new PresenceStudioViewerError(403, 'Invalid hearing scope selection.');
    const selected = value.trim();
    if (key === 'tenant' && (selected === 'all' || selected === 'unscoped'))
      throw new PresenceStudioViewerError(403, 'Invalid hearing scope selection.');
    return selected || undefined;
  };
  const viewer = narrowPresenceStudioScope(resolved, {
    tenant: selection('tenant'),
    organizationId: selection('organizationId'),
    projectId: selection('projectId'),
  });
  if (viewer.tenantSlugs !== 'all' && viewer.tenantSlugs.length > 1)
    throw new PresenceStudioViewerError(403, 'Select one tenant for the hearing.');
  return viewer;
}

/** The framework-neutral viewer the core hearing functions take: the front-desk
 * scope plus the token registration label member resolution reads. */
export function hearingViewerScope(viewer: PresenceStudioViewerContext): SurfaceViewerScope {
  const scope = toFrontDeskViewerScope(viewer);
  const registrationLabel = viewer.principal?.registrationLabel;
  return registrationLabel ? { ...scope, registrationLabel } : scope;
}

/** Canvas loads independently from the JSON request, so carry its validated scope. */
export function hearingScopedUrl(path: string, viewer: PresenceStudioViewerContext): string {
  return hearingScopedUrlForScope(path, toFrontDeskViewerScope(viewer));
}

/** Destination metadata must represent the selected hierarchy before any effect.
 * Hearing storage itself remains tenant/session-scoped, not org/project-partitioned.
 * Studio's owner is its loopback session, passed to core as the explicit owner input. */
export function resolveHearingHandoffScope(
  viewer: PresenceStudioViewerContext,
  kind: 'mission' | 'inventory'
): { tenantSlug?: string; organizationId?: string; projectId?: string } {
  return resolveHearingHandoffScopeForViewer(hearingViewerScope(viewer), kind, {
    owner: viewer.source === 'loopback',
  });
}
