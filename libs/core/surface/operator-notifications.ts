import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { parseSafeJsonObjectValue } from '../foundation/json.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { isVitestProcess } from '../foundation/env.js';
import { nowIso } from '../foundation/time.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from '../secure-io.js';
import { logger } from '../core.js';
import { t, type VocabularyKey } from '../t.js';
import { formatDiagnostic } from '../logger.js';
import { enqueueSurfaceOutboxMessage } from './surface-coordination-store.js';
import type { SurfaceAsyncChannel } from './channel-surface-types.js';
import { getChannelAdapter, listOperatorNotificationChannels } from './channel-adapter-registry.js';
import { addInboxEntry, listInboxEntries } from '../deliverable-inbox.js';
import { sendIMessage } from '../imessage-bridge.js';
import { currentTriggerDeliveryId } from '../trigger-correlation.js';
import { appendOpsAlertLogRecord } from '../ops-alert-log.js';
import { withExecutionContext } from '../authority.js';

/**
 * E2E-04 Task 2: the return path (Kyberion → operator).
 *
 * Workflow events (questions, approvals, completions, deliverables) are pushed
 * to the operator's configured channel instead of waiting to be discovered.
 * Configuration lives in knowledge/personal/notification-preferences.json;
 * unset events fall back to default_channel, and with no default at all the
 * event is recorded to the ops-alert JSONL (never silently dropped).
 */

export type OperatorEvent =
  | 'question'
  | 'approval_required'
  | 'mission_completed'
  | 'mission_failed'
  | 'deliverable_ready'
  | 'ops_alert'
  | 'decision_digest';

export interface NotificationChannelTarget {
  surface: 'slack' | 'imessage' | 'telegram' | 'discord' | 'inbox';
  /** Channel/chat/recipient ID on that surface (e.g. Slack channel ID);
   *  for `inbox` this is a free-form local recipient label. */
  target: string;
}

/**
 * A recurring daily window in which non-urgent events are parked in the local
 * inbox instead of being pushed to the phone. `start` > `end` wraps midnight
 * (e.g. 22:00–07:00). Times are wall-clock in `timezone` (IANA name).
 */
export interface NotificationQuietHours {
  start: string; // HH:MM
  end: string; // HH:MM
  timezone: string;
}

export interface NotificationPreferences {
  default_channel?: NotificationChannelTarget;
  per_event?: Partial<Record<OperatorEvent, NotificationChannelTarget | 'mute'>>;
  quiet_hours?: NotificationQuietHours;
  /** Events that break through quiet hours. Defaults to {@link DEFAULT_URGENT_EVENTS}. */
  urgent_events?: OperatorEvent[];
}

/**
 * Stops and alarms must never wait for morning. A charter tripwire is
 * delivered as `ops_alert`, so this default keeps "stop the world" audible.
 */
export const DEFAULT_URGENT_EVENTS: readonly OperatorEvent[] = ['ops_alert'];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

function minutesOfDayIn(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function isWithinQuietHours(now: Date, quiet: NotificationQuietHours): boolean {
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return false; // an empty window, not "always quiet"
  const current = minutesOfDayIn(now, quiet.timezone);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export interface OperatorNotificationPayload {
  title: string;
  body: string;
  link_hint?: string;
  correlation_id?: string;
}

const PREFERENCES_LOGICAL_PATH = 'personal/notification-preferences.json';
const NOTIFICATION_PREFERENCES_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/notification-preferences.schema.json'
);

// Notification destinations are the channel-adapter registry entries that
// declare `operator_notification` (RS-06).
function isNotificationSurface(value: unknown): value is NotificationChannelTarget['surface'] {
  return typeof value === 'string' && listOperatorNotificationChannels().includes(value);
}
const OPERATOR_EVENTS = new Set<OperatorEvent>([
  'question',
  'approval_required',
  'mission_completed',
  'mission_failed',
  'deliverable_ready',
  'ops_alert',
  'decision_digest',
]);

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function parseNotificationChannelTarget(value: unknown): NotificationChannelTarget | null {
  let record: Record<string, unknown>;
  try {
    record = parseSafeJsonObjectValue(value, 'notification channel target');
  } catch {
    return null;
  }
  if (!hasOnlyKeys(record, ['surface', 'target'])) return null;
  if (
    typeof record.surface !== 'string' ||
    !isNotificationSurface(record.surface) ||
    typeof record.target !== 'string' ||
    !record.target.trim()
  ) {
    return null;
  }
  return {
    surface: record.surface as NotificationChannelTarget['surface'],
    target: record.target.trim(),
  };
}

function parseNotificationPreferences(value: unknown): NotificationPreferences | null {
  let record: Record<string, unknown>;
  try {
    record = parseSafeJsonObjectValue(value, 'notification preferences');
  } catch {
    return null;
  }
  if (!hasOnlyKeys(record, ['default_channel', 'per_event', 'quiet_hours', 'urgent_events'])) {
    return null;
  }

  let quietHours: NotificationQuietHours | undefined;
  if (record.quiet_hours !== undefined) {
    let q: Record<string, unknown>;
    try {
      q = parseSafeJsonObjectValue(record.quiet_hours, 'notification quiet_hours');
    } catch {
      return null;
    }
    if (!hasOnlyKeys(q, ['start', 'end', 'timezone'])) return null;
    if (
      typeof q.start !== 'string' ||
      typeof q.end !== 'string' ||
      typeof q.timezone !== 'string' ||
      !HHMM.test(q.start) ||
      !HHMM.test(q.end) ||
      !isValidTimezone(q.timezone)
    ) {
      return null;
    }
    quietHours = { start: q.start, end: q.end, timezone: q.timezone };
  }

  let urgentEvents: OperatorEvent[] | undefined;
  if (record.urgent_events !== undefined) {
    if (
      !Array.isArray(record.urgent_events) ||
      !record.urgent_events.every(
        (e) => typeof e === 'string' && OPERATOR_EVENTS.has(e as OperatorEvent)
      )
    ) {
      return null;
    }
    urgentEvents = [...new Set(record.urgent_events as OperatorEvent[])];
  }

  const defaultChannel =
    record.default_channel === undefined
      ? undefined
      : parseNotificationChannelTarget(record.default_channel);
  if (record.default_channel !== undefined && !defaultChannel) return null;

  let perEvent: Partial<Record<OperatorEvent, NotificationChannelTarget | 'mute'>> | undefined;
  if (record.per_event !== undefined) {
    let perEventRecord: Record<string, unknown>;
    try {
      perEventRecord = parseSafeJsonObjectValue(record.per_event, 'notification per_event');
    } catch {
      return null;
    }
    perEvent = {};
    for (const [event, target] of Object.entries(perEventRecord)) {
      if (!OPERATOR_EVENTS.has(event as OperatorEvent)) return null;
      if (target === 'mute') {
        perEvent[event as OperatorEvent] = 'mute';
        continue;
      }
      const parsedTarget = parseNotificationChannelTarget(target);
      if (!parsedTarget) return null;
      perEvent[event as OperatorEvent] = parsedTarget;
    }
  }

  return {
    ...(defaultChannel ? { default_channel: defaultChannel } : {}),
    ...(perEvent ? { per_event: perEvent } : {}),
    ...(quietHours ? { quiet_hours: quietHours } : {}),
    ...(urgentEvents ? { urgent_events: urgentEvents } : {}),
  };
}

export function notificationPreferencesPath(): string {
  return assertSafeRepositoryPath(pathResolver.knowledge(PREFERENCES_LOGICAL_PATH), {
    allowMissingLeaf: true,
  });
}

function notificationPreferencesCatalogAtPath(filePath: string) {
  return defineCatalog<NotificationPreferences>({
    id: 'notification-preferences',
    path: filePath,
    schema: NOTIFICATION_PREFERENCES_SCHEMA_PATH,
  });
}

export function loadNotificationPreferences(): NotificationPreferences {
  try {
    // The preferences file lives in the personal tier; reading it is the
    // concierge role's job (routing delivery, not personal data access). Any
    // caller — baseline check, pipeline worker, CLI — needs this elevation or
    // every configured channel silently reads as "unconfigured".
    return withExecutionContext('sovereign_concierge', () => {
      const filePath = notificationPreferencesPath();
      if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) return {};
      return (
        parseNotificationPreferences(notificationPreferencesCatalogAtPath(filePath).load()) || {}
      );
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`[operator-notifications] failed to read preferences: ${detail}`);
    return {};
  }
}

export function saveNotificationPreferences(prefs: NotificationPreferences): string {
  const parsed = parseNotificationPreferences(prefs);
  if (!parsed) throw new Error('Invalid notification preferences');
  const filePath = notificationPreferencesPath();
  const validated = notificationPreferencesCatalogAtPath(filePath).validate(parsed, filePath);
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, `${JSON.stringify(validated, null, 2)}\n`);
  return filePath;
}

// Rate limit per event×correlation so retry storms do not spam the operator
// (same shape as UX-01's shouldPostBridgeError, event-scoped).
const DEFAULT_NOTIFY_INTERVAL_MS = 10 * 60 * 1000;
const lastNotifiedAt = new Map<string, number>();

export function shouldNotifyOperator(
  dedupeKey: string,
  nowMs: number = Date.now(),
  intervalMs: number = DEFAULT_NOTIFY_INTERVAL_MS
): boolean {
  const last = lastNotifiedAt.get(dedupeKey);
  if (last !== undefined && nowMs - last < intervalMs) return false;
  lastNotifiedAt.set(dedupeKey, nowMs);
  if (lastNotifiedAt.size > 1000) {
    const oldest = lastNotifiedAt.keys().next().value;
    if (oldest !== undefined) lastNotifiedAt.delete(oldest);
  }
  return true;
}

export function resetOperatorNotificationRateLimiter(): void {
  lastNotifiedAt.clear();
}

const EVENT_LABEL_KEYS: Record<OperatorEvent, VocabularyKey | null> = {
  question: 'surface:operator_event_question',
  approval_required: 'surface:operator_event_approval_required',
  mission_completed: 'surface:operator_event_mission_completed',
  mission_failed: 'surface:operator_event_mission_failed',
  deliverable_ready: 'surface:operator_event_deliverable_ready',
  ops_alert: 'surface:operator_event_ops_alert',
  // The digest title is localized by the digest itself.
  decision_digest: null,
};

function eventLabel(event: OperatorEvent): string {
  const key = EVENT_LABEL_KEYS[event];
  return key ? t(key) : '🗂';
}

function formatNotificationText(
  event: OperatorEvent,
  payload: OperatorNotificationPayload
): string {
  return [
    `${eventLabel(event)} — ${payload.title}`,
    payload.body,
    payload.link_hint ? `→ ${payload.link_hint}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function recordUndeliveredNotification(
  event: OperatorEvent,
  payload: OperatorNotificationPayload,
  reason: string
): void {
  try {
    const logPath = assertSafeRepositoryPath(
      pathResolver.shared('observability/ops-alerts.jsonl'),
      { allowMissingLeaf: true }
    );
    safeMkdir(path.dirname(logPath), { recursive: true });
    appendOpsAlertLogRecord(logPath, {
      ts: nowIso(),
      kind: 'operator_notification_undelivered',
      event,
      title: payload.title,
      correlation_id: payload.correlation_id,
      reason,
    });
  } catch {
    // observability only — never throw from the notification path
  }
}

export function resolveOperatorNotificationRoute(
  event: OperatorEvent,
  prefs: NotificationPreferences,
  now: Date = new Date()
): NotificationChannelTarget | 'mute' | null {
  const perEvent = prefs.per_event?.[event];
  const route = perEvent || prefs.default_channel || null;
  // Muted stays muted and an unconfigured event stays undelivered-and-recorded;
  // quiet hours only ever *defers* a real delivery to the local inbox.
  if (!route || route === 'mute' || !prefs.quiet_hours) return route;
  const urgent = prefs.urgent_events ?? DEFAULT_URGENT_EVENTS;
  if (urgent.includes(event)) return route;
  if (route.surface === 'inbox') return route;
  return isWithinQuietHours(now, prefs.quiet_hours)
    ? { surface: 'inbox', target: 'quiet-hours' }
    : route;
}

function deliver(
  route: NotificationChannelTarget,
  text: string,
  correlationId: string,
  title: string
): Promise<void> {
  // Delivery mechanics are declared per channel in the adapter registry (RS-06);
  // an unregistered surface fails closed in getChannelAdapter.
  const delivery = getChannelAdapter(route.surface).operator_notification?.delivery;
  switch (delivery) {
    case 'imessage-direct':
      sendIMessage({ recipient: route.target, text });
      return;
    case 'local-inbox': {
      // Local fallback surface: no bridge/daemon required. The notification
      // lands in the deliverable inbox that `pnpm kyberion` surfaces on the
      // home screen and `pnpm kyberion inbox` lists/acknowledges.
      const entryId = `INBOX-N-${correlationId
        .replace(/[^A-Za-z0-9]/g, '')
        .slice(-24)
        .toUpperCase()}`;
      withExecutionContext('surface_runtime', () => {
        const alreadyQueued = listInboxEntries({ limit: 500 }).some(
          (entry) => entry.entry_id === entryId
        );
        if (!alreadyQueued) {
          addInboxEntry({
            entryId,
            title: title || 'Operator notification',
            summary: text,
            kind: 'operator_notification',
            status: 'unread',
          });
        }
      });
      return;
    }
    // Remote chat surfaces: enqueue to the surface outbox; each bridge drains
    // its own outbox and performs the actual API send.
    case 'surface-outbox':
      enqueueSurfaceOutboxMessage({
        surface: route.surface as SurfaceAsyncChannel,
        correlationId,
        channel: route.target,
        threadTs: '',
        text,
        source: 'system',
      });
      return;
    default:
      throw new Error(
        `[operator-notifications] channel "${route.surface}" declares no operator_notification delivery in the channel adapter registry`
      );
  }
}

/**
 * Push a workflow event to the operator's configured channel.
 * Returns true when the notification was handed to a delivery path,
 * false when muted, rate-limited, unconfigured, or delivery failed.
 * Never throws — callers wire this in as a fire-and-forget side effect.
 */
export async function notifyOperator(
  event: OperatorEvent,
  payload: OperatorNotificationPayload
): Promise<boolean> {
  return notifyOperatorSync(event, payload);
}

/** Synchronous delivery path used when a caller must return an honest receipt. */
export function notifyOperatorSync(
  event: OperatorEvent,
  payload: OperatorNotificationPayload
): boolean {
  // Tests exercising real mission flows must not pollute the operator's
  // real inbox/channels (81 phantom entries taught us this). Suites that
  // genuinely test delivery mock this module or set the override.
  if (isVitestProcess() && getRegisteredEnvText('KYBERION_ALLOW_TEST_NOTIFICATIONS') !== '1') {
    return false;
  }
  try {
    const prefs = loadNotificationPreferences();
    const route = resolveOperatorNotificationRoute(event, prefs);
    if (route === 'mute') return false;
    if (!route) {
      recordUndeliveredNotification(event, payload, 'no_channel_configured');
      return false;
    }
    // EV-09: when this notification is a consequence of a trigger firing,
    // inherit that delivery id so the operator can trace the notification back
    // to its cause in one hop. An explicit correlation_id still wins.
    const correlationId =
      payload.correlation_id ||
      currentTriggerDeliveryId() ||
      `notify:${event}:${Date.now().toString(36)}`;
    // Dedupe on the resolved correlation: two notifications from one firing are
    // the same event, which the title-only fallback could not express.
    const dedupeKey = `${event}:${payload.correlation_id || currentTriggerDeliveryId() || payload.title}`;
    if (!shouldNotifyOperator(dedupeKey)) return false;
    deliver(route, formatNotificationText(event, payload), correlationId, payload.title);
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(
      formatDiagnostic({
        component: 'operator-notifications',
        what: `delivery failed for ${event}`,
        why: detail,
      })
    );
    recordUndeliveredNotification(event, payload, `delivery_failed:${detail.slice(0, 200)}`);
    return false;
  }
}
