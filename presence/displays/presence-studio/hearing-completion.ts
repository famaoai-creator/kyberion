import {
  readHearingCompletion as readHearingCompletionForScope,
  withoutHearingCompletionFields,
  type HearingCompletion,
  type HearingCompletionOptions,
} from '@agent/core/surface/hearing-completion';
import type { HearingRecord } from '@agent/core/surface/hearing';
import { hearingViewerScope } from './hearing-request-scope.js';
import type { PresenceStudioViewerContext } from './security.js';

export { withoutHearingCompletionFields };
export type { HearingCompletion };

/** This surface's completion links: front-desk destinations hosted here stay relative. */
export const PRESENCE_STUDIO_HEARING_COMPLETION = { currentSurface: 'presence-studio' } as const;

/** Completion options for one viewer: Studio's owner is its loopback session. */
export function presenceStudioHearingCompletion(
  viewer: PresenceStudioViewerContext
): HearingCompletionOptions {
  return { ...PRESENCE_STUDIO_HEARING_COMPLETION, owner: viewer.source === 'loopback' };
}

/** Read-only proof of the handoff. Missing, corrupt and unauthorized targets all
 * yield the same non-actionable marker, without leaking IDs or enabling retries. */
export function readHearingCompletion(
  record: HearingRecord,
  viewer: PresenceStudioViewerContext
): HearingCompletion | undefined {
  return readHearingCompletionForScope(
    record,
    hearingViewerScope(viewer),
    presenceStudioHearingCompletion(viewer)
  );
}
