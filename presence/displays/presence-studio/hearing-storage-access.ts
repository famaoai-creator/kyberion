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
 * The core facade refuses non-owner access with this surface's own 403 error. */
export function hearingStorageForViewer(viewer: PresenceStudioViewerContext): HearingStorage {
  return hearingStorageForScope(viewer, {
    denied: (message) => new PresenceStudioViewerError(403, message),
  });
}

/** Exact receipt scope is server-derived, including narrower organization/project selection. */
export function hearingDecisionScopeKey(viewer: PresenceStudioViewerContext): string {
  return hearingDecisionScopeKeyForScope(toFrontDeskViewerScope(viewer));
}
