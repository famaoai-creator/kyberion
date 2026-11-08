import {
  assertHearingHandoffSnapshot as assertHearingHandoffSnapshotForScope,
  hearingHandoffSnapshot as hearingHandoffSnapshotForScope,
  withHearingHandoffSnapshot as withHearingHandoffSnapshotForScope,
  type HearingHandoffSnapshot,
} from '@agent/core/surface/hearing-handoff-snapshot';
import type { HearingRecord } from '@agent/core/surface/hearing';
import { PRESENCE_STUDIO_HEARING_COMPLETION } from './hearing-completion.js';
import { hearingViewerScope } from './hearing-request-scope.js';
import type { PresenceStudioViewerContext } from './security.js';

export type { HearingHandoffSnapshot };

/** A freshness validator, never an authorization capability (see the core module). */
export function hearingHandoffSnapshot(
  record: HearingRecord,
  viewer: PresenceStudioViewerContext
): HearingHandoffSnapshot | undefined {
  return hearingHandoffSnapshotForScope(
    record,
    hearingViewerScope(viewer),
    PRESENCE_STUDIO_HEARING_COMPLETION
  );
}

/** Keep proof and the exact displayed record in one atomic client assignment. */
export function withHearingHandoffSnapshot(
  record: HearingRecord,
  viewer: PresenceStudioViewerContext
): HearingRecord & { handoff_snapshot?: HearingHandoffSnapshot } {
  return withHearingHandoffSnapshotForScope(
    record,
    hearingViewerScope(viewer),
    PRESENCE_STUDIO_HEARING_COMPLETION
  );
}

/** Validate before preparation or replay. */
export function assertHearingHandoffSnapshot(
  body: unknown,
  record: HearingRecord,
  viewer: PresenceStudioViewerContext
): HearingHandoffSnapshot {
  return assertHearingHandoffSnapshotForScope(
    body,
    record,
    hearingViewerScope(viewer),
    PRESENCE_STUDIO_HEARING_COMPLETION
  );
}
