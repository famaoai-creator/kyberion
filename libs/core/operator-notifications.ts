import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { parseSafeJsonObjectValue } from './foundation/json.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { nowIso } from './foundation/time.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from './secure-io.js';
import { logger } from './core.js';
import { enqueueSurfaceOutboxMessage } from './surface-coordination-store.js';
import { sendIMessage } from './imessage-bridge.js';
import { currentTriggerDeliveryId } from './trigger-correlation.js';
import { appendOpsAlertLogRecord } from './ops-alert-log.js';

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
  | 'ops_alert';

export interface NotificationChannelTarget {
  surface: 'slack' | 'imessage' | 'telegram' | 'discord';
  /** Channel/chat/recipient ID on that surface (e.g. Slack channel ID). */
  target: string;
}

export interface NotificationPreferences {
  default_channel?: NotificationChannelTarget;
  per_event?: Partial<Record<OperatorEvent, NotificationChannelTarget | 'mute'>>;
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

const NOTIFICATION_SURFACES = new Set<NotificationChannelTarget['surface']>([
  'slack',
  'imessage',
  'telegram',
  'discord',
]);
const OPERATOR_EVENTS = new Set<OperatorEvent>([
  'question',
  'approval_required',
  'mission_completed',
  'mission_failed',
  'deliverable_ready',
  'ops_alert',
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
    !NOTIFICATION_SURFACES.has(record.surface as NotificationChannelTarget['surface']) ||
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
  if (!hasOnlyKeys(record, ['default_channel', 'per_event'])) return null;

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
    const filePath = notificationPreferencesPath();
    if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) return {};
    return (
      parseNotificationPreferences(notificationPreferencesCatalogAtPath(filePath).load()) || {}
    );
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

const EVENT_LABEL: Record<OperatorEvent, string> = {
  question: '❓ 質問',
  approval_required: '🔐 承認待ち',
  mission_completed: '✅ ミッション完了',
  mission_failed: '❌ ミッション失敗',
  deliverable_ready: '📦 成果物',
  ops_alert: '🚨 運用アラート',
};

function formatNotificationText(
  event: OperatorEvent,
  payload: OperatorNotificationPayload
): string {
  return [
    `${EVENT_LABEL[event]} — ${payload.title}`,
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
  prefs: NotificationPreferences
): NotificationChannelTarget | 'mute' | null {
  const perEvent = prefs.per_event?.[event];
  if (perEvent) return perEvent;
  return prefs.default_channel || null;
}

function deliver(
  route: NotificationChannelTarget,
  text: string,
  correlationId: string
): Promise<void> {
  switch (route.surface) {
    case 'imessage':
      sendIMessage({ recipient: route.target, text });
      return;
    // slack/telegram/discord: enqueue to the surface outbox; each bridge
    // drains its own outbox and performs the actual API send.
    default:
      enqueueSurfaceOutboxMessage({
        surface: route.surface,
        correlationId,
        channel: route.target,
        threadTs: '',
        text,
        source: 'system',
      });
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
  if (process.env.VITEST && getRegisteredEnvText('KYBERION_ALLOW_TEST_NOTIFICATIONS') !== '1') {
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
    deliver(route, formatNotificationText(event, payload), correlationId);
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`[operator-notifications] delivery failed for ${event}: ${detail}`);
    recordUndeliveredNotification(event, payload, `delivery_failed:${detail.slice(0, 200)}`);
    return false;
  }
}
