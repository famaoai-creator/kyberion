import {
  readHearingCompletion as readHearingCompletionForScope,
  withoutHearingCompletionFields,
  type HearingCompletion,
} from '@agent/core/surface/hearing-completion';
import type { HearingRecord } from '@agent/core/surface/hearing';
import { hearingViewerScope } from './hearing-request-scope.js';
import type { PresenceStudioViewerContext } from './security.js';

export { withoutHearingCompletionFields };
export type { HearingCompletion };

/** This surface's completion links: front-desk destinations hosted here stay relative. */
export const PRESENCE_STUDIO_HEARING_COMPLETION = { currentSurface: 'presence-studio' } as const;

/** Read-only proof of the handoff. Missing, corrupt and unauthorized targets all
 * yield the same non-actionable marker, without leaking IDs or enabling retries. */
export function readHearingCompletion(
  record: HearingRecord,
  viewer: PresenceStudioViewerContext
): HearingCompletion | undefined {
  return readHearingCompletionForScope(
    record,
    hearingViewerScope(viewer),
    PRESENCE_STUDIO_HEARING_COMPLETION
  );
}
