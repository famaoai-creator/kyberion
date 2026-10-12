/** Read-only intake coverage and continuation evidence; never clears or advances work. */
import { safeLstat } from '../secure-io.js';
import type { DotCharter } from './dot-charter.js';
import type { DotRuntimeDeps } from './dot-runtime.js';
import type { DotStatusSection } from './dot-extensions.js';
import {
  inspectDotInboundEventWindow,
  DOT_EVENT_LOOKBACK_MS,
  DOT_EVENT_MAX_DUE_PER_SWEEP,
} from './dot-event-intake.js';
import {
  EventContinuationHold,
  readEventContinuation,
  assertEventSource,
  eventContinuationLedger,
  EVENT_CONTINUATION_PENDING,
  EVENT_CONTINUATION_BYTES,
  EVENT_CONTINUATION_ROWS,
} from './dot-event-continuation.js';

export function inspectDotEventIntake(
  c: DotCharter,
  deps: DotRuntimeDeps = {}
): Record<string, unknown> {
  try {
    const state = readEventContinuation(c, deps);
    if (state) {
      const size = assertEventSource(c, state, deps);
      return {
        mode: 'durable',
        state: 'recorded',
        activation_id: state.activation_id,
        activated_at: state.activated_at,
        history_before_offset: state.source.floor,
        next_offset: state.source.offset,
        unread_bytes: size - state.source.offset,
        recorded_pending: state.pending.length,
        pending_capacity: EVENT_CONTINUATION_PENDING,
        unresolved_attempts: state.pending.filter((p) => p.attempt).length,
        oldest_pending_at: state.pending.map((p) => p.received_at).sort()[0] ?? null,
        event_read_byte_limit: EVENT_CONTINUATION_BYTES,
        event_read_row_limit: EVENT_CONTINUATION_ROWS,
        next: 'Recorded evidence only. Unresolved dispatched attempts never expire; inspect matching terminal receipts before governed recovery. This read does not acknowledge or retry work.',
        limitation:
          'Existing wake-receipt replay is not bounded by these event-read limits; downstream effects still need idempotency.',
      };
    }
    const file = eventContinuationLedger(c, deps.rootDir);
    try {
      safeLstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
        return {
          mode: 'legacy',
          state: 'unrecorded',
          total_pending: null,
          next: 'No event ledger observed; absence is not a delivery guarantee.',
        };
      throw error;
    }
    const window = inspectDotInboundEventWindow(c.scope.tenant_slug || undefined, deps);
    return {
      mode: 'legacy',
      state: 'observed',
      ...window,
      total_pending: null,
      initial_lookback_ms: DOT_EVENT_LOOKBACK_MS,
      offered_per_sweep_limit: DOT_EVENT_MAX_DUE_PER_SWEEP,
      next: window.history_outside_window
        ? 'History exists outside the scan window; total pending is unknown. Do not replay older events automatically.'
        : 'Only current scan coverage is observed; expiry, matching and receipts can exclude events. This does not establish completion.',
      adoption:
        'Forward continuation requires explicit adoption while draft/paused and supervisors/editors are stopped; it does not recover historical events.',
    };
  } catch (error) {
    return {
      reason:
        error instanceof EventContinuationHold ? error.reason : 'Evidence cannot be read safely',
      mode: c.attention.event_delivery ? 'durable' : 'legacy',
      state: 'held',
      total_pending: null,
      next: 'Evidence is invalid, unreadable, missing, changed, or adoption is incomplete. Inspect source and continuation state; never delete/reset evidence to resume.',
    };
  }
}
export function dotEventIntakeStatusSection(): DotStatusSection {
  return { id: 'event_intake', collect: (c, ctx) => inspectDotEventIntake(c, ctx) };
}
