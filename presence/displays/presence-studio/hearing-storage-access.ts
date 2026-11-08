import {
  hearingDecisionScopeKey as hearingDecisionScopeKeyForScope,
  hearingStorageForScope,
  type HearingStorage,
} from '@agent/core/surface/hearing-storage-access';
import {
  PresenceStudioViewerError,
  toFrontDeskViewerScope,
  type PresenceStudioViewerContext,
} from './security.js';

export type { HearingStorage };

/** Internal facade: callers MUST pass the server-resolved viewer, never request body scope.
 * The core facade refuses non-owner access with this surface's own 403 error.
 * Studio's owner is its credential-free loopback session (every such request is
 * localadmin here), passed to core as the explicit owner input. */
export function hearingStorageForViewer(viewer: PresenceStudioViewerContext): HearingStorage {
  return hearingStorageForScope(viewer, {
    owner: viewer.source === 'loopback',
    denied: (message) => new PresenceStudioViewerError(403, message),
  });
}

/** Exact receipt scope is server-derived, including narrower organization/project selection. */
export function hearingDecisionScopeKey(viewer: PresenceStudioViewerContext): string {
  return hearingDecisionScopeKeyForScope(toFrontDeskViewerScope(viewer));
}
