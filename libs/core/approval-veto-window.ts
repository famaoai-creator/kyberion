import {
  appendGovernedArtifactJsonl,
  writeGovernedArtifactJson,
  type GovernedArtifactRole,
} from './artifact-store.js';
import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  decideApprovalRequest,
  listApprovalRequests,
  loadApprovalRequest,
  type ApprovalRequestRecord,
} from './approval-store.js';
import type { AutonomousOpsPolicy } from './autonomous-ops-gate.js';
import { nowIso } from './foundation/time.js';

/**
 * Autonomous-operation P1-7: the veto window ("silence is consent, but only
 * silence the operator could actually hear").
 *
 * A veto-level request proceeds on its own once its window elapses without an
 * objection. The window is safety-first by construction:
 *
 *  - the clock starts only when a surface bridge confirms the notification was
 *    delivered (`recordApprovalDeliveryReceipt`), never when it was queued;
 *  - only minutes inside the operator's active hours count;
 *  - a notification not delivered within the delivery grace falls back to an
 *    ordinary human decision — it can never auto-proceed afterwards;
 *  - shadow windows record "would have proceeded" and leave the request for a
 *    human, so the operator's real decision can be compared (P1-10).
 */

export type ActiveHours = NonNullable<AutonomousOpsPolicy['active_hours']>;

export interface ApprovalVetoWindow {
  /** Active-hours minutes of silence after delivery before the request proceeds. */
  windowMinutes: number;
  activeHours?: ActiveHours;
  /** The notification must be delivered before this instant, or the request becomes a decision. */
  deliveryDeadlineAt: string;
  deliveredAt?: string;
  /** Computed on delivery: when silence becomes consent. */
  proceedsAt?: string;
  /** Shadow windows never decide; they only record that the request would have proceeded. */
  shadow?: boolean;
  /** Set once the window can no longer auto-proceed; the request then waits for a human. */
  fallback?: 'undelivered';
  shadowElapsedAt?: string;
}

export type VetoWindowState =
  'awaiting_delivery' | 'counting' | 'elapsed' | 'elapsed_shadow' | 'undelivered';

export const DEFAULT_VETO_DELIVERY_GRACE_MINUTES = 30;
export const VETO_WINDOW_DECIDER = 'policy:veto-window';
const APPROVAL_DELIVERY_CORRELATION = /^approval:([a-z][a-z0-9-]{0,63}):([0-9a-f-]{36})$/i;
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60_000;
// Bounds the search for a deadline; a window that cannot fit is treated as never elapsing.
const MAX_SCAN_MINUTES = 60 * 24 * 60;

function parseHhMm(value: string): number {
  const match = HH_MM.exec(value);
  if (!match) throw new Error(`[POLICY_VIOLATION] Invalid active-hours time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function localMinuteOfDay(ms: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

/** True when the minute starting at `ms` lies inside the active hours (end exclusive). */
export function isWithinActiveHours(ms: number, activeHours?: ActiveHours): boolean {
  if (!activeHours) return true;
  const start = parseHhMm(activeHours.start);
  const end = parseHhMm(activeHours.end);
  if (start === end) return true;
  const minute = localMinuteOfDay(ms, activeHours.timezone);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/**
 * The instant at which `windowMinutes` active minutes have passed since `startMs`.
 * Minutes outside the active hours pause the clock. Returns null when the window
 * cannot complete within the scan bound (e.g. an empty active-hours range).
 */
export function computeVetoDeadline(
  startMs: number,
  windowMinutes: number,
  activeHours?: ActiveHours
): Date | null {
  const minutes = Math.max(0, Math.ceil(windowMinutes));
  if (!activeHours) return new Date(startMs + minutes * MINUTE_MS);
  let cursor = Math.ceil(startMs / MINUTE_MS) * MINUTE_MS;
  let counted = 0;
  for (let scanned = 0; counted < minutes; scanned += 1) {
    if (scanned >= MAX_SCAN_MINUTES) return null;
    if (isWithinActiveHours(cursor, activeHours)) counted += 1;
    cursor += MINUTE_MS;
  }
  return new Date(cursor);
}

export function buildVetoWindow(params: {
  windowMinutes: number;
  activeHours?: ActiveHours;
  shadow?: boolean;
  deliveryGraceMinutes?: number;
  now?: number;
}): ApprovalVetoWindow {
  if (!Number.isFinite(params.windowMinutes) || params.windowMinutes <= 0) {
    throw new Error('[POLICY_VIOLATION] Veto window requires a positive window length');
  }
  const now = params.now ?? Date.now();
  const grace = params.deliveryGraceMinutes ?? DEFAULT_VETO_DELIVERY_GRACE_MINUTES;
  return {
    windowMinutes: params.windowMinutes,
    ...(params.activeHours ? { activeHours: params.activeHours } : {}),
    deliveryDeadlineAt: new Date(now + grace * MINUTE_MS).toISOString(),
    ...(params.shadow ? { shadow: true } : {}),
  };
}

function parseInstant(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** Pure state of a veto window at `now`; malformed timestamps never read as elapsed. */
export function evaluateVetoWindow(veto: ApprovalVetoWindow, now = Date.now()): VetoWindowState {
  if (veto.fallback) return 'undelivered';
  if (!veto.deliveredAt) {
    const deliveryDeadline = parseInstant(veto.deliveryDeadlineAt);
    return !Number.isFinite(deliveryDeadline) || deliveryDeadline <= now
      ? 'undelivered'
      : 'awaiting_delivery';
  }
  const proceedsAt = parseInstant(veto.proceedsAt);
  if (!Number.isFinite(proceedsAt) || proceedsAt > now) return 'counting';
  return veto.shadow ? 'elapsed_shadow' : 'elapsed';
}

function writeRecord(role: GovernedArtifactRole, record: ApprovalRequestRecord): void {
  writeGovernedArtifactJson(
    role,
    approvalRequestLogicalPath(record.storageChannel, record.id),
    record
  );
}

function appendEvent(
  role: GovernedArtifactRole,
  record: ApprovalRequestRecord,
  event: string,
  extra: Record<string, unknown> = {}
): void {
  appendGovernedArtifactJsonl(role, approvalEventLogicalPath(record.storageChannel), {
    ts: nowIso(),
    event,
    request_id: record.id,
    correlation_id: record.correlationId,
    channel: record.channel,
    thread_ts: record.threadTs,
    ...extra,
  });
}

/** The outbox correlation id that lets a delivery receipt find its approval request. */
export function approvalDeliveryCorrelationId(
  record: Pick<ApprovalRequestRecord, 'storageChannel' | 'id'>
): string {
  return `approval:${record.storageChannel}:${record.id}`;
}

/**
 * Start the veto clock for a request whose notification reached the operator.
 * Idempotent: the first delivery wins, and a request past its delivery deadline
 * stays a human decision even if a late delivery arrives.
 */
export function markApprovalNotificationDelivered(
  role: GovernedArtifactRole,
  params: { storageChannel: string; requestId: string; deliveredAt?: string }
): ApprovalRequestRecord | null {
  const record = loadApprovalRequest(params.storageChannel, params.requestId);
  if (!record?.veto || record.status !== 'pending' || record.veto.deliveredAt) return record;
  const deliveredMs = parseInstant(params.deliveredAt ?? nowIso());
  if (!Number.isFinite(deliveredMs)) return record;
  if (evaluateVetoWindow(record.veto, deliveredMs) === 'undelivered') {
    return fallBackToDecision(role, record);
  }
  const proceedsAt = computeVetoDeadline(
    deliveredMs,
    record.veto.windowMinutes,
    record.veto.activeHours
  );
  const updated: ApprovalRequestRecord = {
    ...record,
    veto: {
      ...record.veto,
      deliveredAt: new Date(deliveredMs).toISOString(),
      ...(proceedsAt ? { proceedsAt: proceedsAt.toISOString() } : {}),
    },
  };
  if (!proceedsAt) return fallBackToDecision(role, updated);
  writeRecord(role, updated);
  appendEvent(role, updated, 'notification_delivered', {
    delivered_at: updated.veto?.deliveredAt,
    proceeds_at: updated.veto?.proceedsAt,
  });
  return updated;
}

function fallBackToDecision(
  role: GovernedArtifactRole,
  record: ApprovalRequestRecord
): ApprovalRequestRecord {
  if (!record.veto || record.veto.fallback) return record;
  const updated: ApprovalRequestRecord = {
    ...record,
    veto: { ...record.veto, fallback: 'undelivered' },
  };
  writeRecord(role, updated);
  appendEvent(role, updated, 'veto_window_fallback', { reason: 'undelivered' });
  return updated;
}

/**
 * Surface-delivery hook: when an outbox message tagged with an approval
 * correlation id is delivered, start that request's veto clock. Never throws —
 * a receipt failure must not fail the delivery that already happened.
 */
export function recordApprovalDeliveryReceipt(
  message: { correlation_id?: string },
  deliveredAt: string = nowIso()
): void {
  const match = APPROVAL_DELIVERY_CORRELATION.exec(message.correlation_id ?? '');
  if (!match) return;
  try {
    markApprovalNotificationDelivered('surface_runtime', {
      storageChannel: match[1].toLowerCase(),
      requestId: match[2].toLowerCase(),
      deliveredAt,
    });
  } catch {
    /* observability of the veto clock must never break delivery */
  }
}

export interface VetoWindowTickResult {
  proceeded: ApprovalRequestRecord[];
  shadowElapsed: ApprovalRequestRecord[];
  fellBack: ApprovalRequestRecord[];
  /** Requests the tick could not settle (e.g. expired meanwhile); the rest still advance. */
  errors: Array<{ requestId: string; error: string }>;
}

/**
 * Advance every pending veto window. Elapsed windows are decided `approved` by
 * the policy (a service, never presented as a human); undelivered ones become
 * human decisions; shadow windows are only recorded.
 */
export function tickVetoWindows(
  role: GovernedArtifactRole,
  params: { now?: number; storageChannels?: string[] } = {}
): VetoWindowTickResult {
  const now = params.now ?? Date.now();
  const result: VetoWindowTickResult = {
    proceeded: [],
    shadowElapsed: [],
    fellBack: [],
    errors: [],
  };
  const pending = listApprovalRequests({
    status: 'pending',
    ...(params.storageChannels ? { storageChannels: params.storageChannels } : {}),
  });
  for (const record of pending) {
    if (!record.veto) continue;
    const veto = record.veto;
    try {
      const state = evaluateVetoWindow(veto, now);
      if (state === 'undelivered' && !veto.fallback) {
        result.fellBack.push(fallBackToDecision(role, record));
      } else if (state === 'elapsed_shadow' && !veto.shadowElapsedAt) {
        const updated: ApprovalRequestRecord = {
          ...record,
          veto: { ...veto, shadowElapsedAt: new Date(now).toISOString() },
        };
        writeRecord(role, updated);
        appendEvent(role, updated, 'veto_window_elapsed_shadow', {
          proceeds_at: veto.proceedsAt,
        });
        result.shadowElapsed.push(updated);
      } else if (state === 'elapsed') {
        result.proceeded.push(
          decideApprovalRequest(role, {
            channel: record.channel,
            storageChannel: record.storageChannel,
            requestId: record.id,
            decision: 'approved',
            decidedBy: VETO_WINDOW_DECIDER,
            decidedByType: 'service',
            authenticated: false,
            note: `no objection within ${veto.windowMinutes} active minutes after delivery`,
          })
        );
      }
    } catch (error) {
      result.errors.push({
        requestId: record.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
