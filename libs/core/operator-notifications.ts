import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';
import { logger } from './core.js';
import { enqueueSurfaceOutboxMessage } from './surface-coordination-store.js';
import { sendIMessage } from './imessage-bridge.js';

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

export function notificationPreferencesPath(): string {
  return pathResolver.knowledge(PREFERENCES_LOGICAL_PATH);
}

export function loadNotificationPreferences(): NotificationPreferences {
  const filePath = notificationPreferencesPath();
  try {
    if (!safeExistsSync(filePath)) return {};
    return JSON.parse(
      safeReadFile(filePath, { encoding: 'utf8' }) as string
    ) as NotificationPreferences;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`[operator-notifications] failed to read preferences: ${detail}`);
    return {};
  }
}

export function saveNotificationPreferences(prefs: NotificationPreferences): string {
  const filePath = notificationPreferencesPath();
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, `${JSON.stringify(prefs, null, 2)}\n`);
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
    const logPath = pathResolver.shared('observability/ops-alerts.jsonl');
    safeMkdir(path.dirname(logPath), { recursive: true });
    safeAppendFileSync(
      logPath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'operator_notification_undelivered',
        event,
        title: payload.title,
        correlation_id: payload.correlation_id,
        reason,
      })}\n`
    );
  } catch {
    // observability only — never throw from the notification path
  }
}

function resolveRoute(
  event: OperatorEvent,
  prefs: NotificationPreferences
): NotificationChannelTarget | 'mute' | null {
  const perEvent = prefs.per_event?.[event];
  if (perEvent) return perEvent;
  return prefs.default_channel || null;
}

async function deliver(
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
  try {
    const prefs = loadNotificationPreferences();
    const route = resolveRoute(event, prefs);
    if (route === 'mute') return false;
    if (!route) {
      recordUndeliveredNotification(event, payload, 'no_channel_configured');
      return false;
    }
    const dedupeKey = `${event}:${payload.correlation_id || payload.title}`;
    if (!shouldNotifyOperator(dedupeKey)) return false;
    await deliver(
      route,
      formatNotificationText(event, payload),
      payload.correlation_id || `notify:${event}:${Date.now().toString(36)}`
    );
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`[operator-notifications] delivery failed for ${event}: ${detail}`);
    recordUndeliveredNotification(event, payload, `delivery_failed:${detail.slice(0, 200)}`);
    return false;
  }
}
