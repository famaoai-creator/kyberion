import { appendJsonLine, parseSafeJsonInput } from './foundation/json.js';
import { safeExec, safeMkdir, safeExistsSync, safeReadFile } from './secure-io.js';
import * as pathResolver from './path-resolver.js';
import { logger } from './core.js';
import {
  loadNotificationPreferences,
  notifyOperatorSync,
  resolveOperatorNotificationRoute,
} from './operator-notifications.js';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export type OpsAlertSeverity = 'info' | 'warning' | 'critical';

export interface OpsAlertInput {
  severity: OpsAlertSeverity;
  title: string;
  context: Record<string, unknown>;
  recommendation: string;
  options?: string[];
  dedupe_key?: string;
  /** Coarse alert domain (e.g. 'scheduler') used by the triage summary. */
  category?: string;
}

export interface OpsAlertReceipt {
  id: string;
  recorded_path: string;
  webhook_attempted: boolean;
  webhook_delivered: boolean;
  operator_attempted: boolean;
  operator_delivered: boolean;
  suppressed: boolean;
  error?: string;
}

export interface OpsAlertOptions {
  now?: Date;
  alertLogPath?: string;
  webhookUrl?: string;
  minIntervalMs?: number;
}

const DEFAULT_MIN_INTERVAL_MS = 10 * 60 * 1000;
const lastSentAt = new Map<string, number>();

/** Env var carrying the webhook URL used for actual alert delivery. */
export const OPS_ALERT_WEBHOOK_ENV = 'KYBERION_OPS_ALERT_WEBHOOK_URL';

export function defaultOpsAlertLogPath(): string {
  return pathResolver.shared('observability/ops-alerts.jsonl');
}

function defaultAlertLogPath(): string {
  return defaultOpsAlertLogPath();
}

export interface OpsAlertChannelStatus {
  configured: boolean;
  webhook_configured: boolean;
  operator_route_configured: boolean;
  env_var: string;
}

/**
 * LC-02: whether ops alerts can actually reach an operator. Webhook delivery
 * is this module's own path; the operator-notification route (Slack/iMessage
 * preferences) is resolved by the caller (operator-notifications.ts owns that
 * config) and passed in, so this module never grows an import cycle.
 */
export function resolveOpsAlertChannelStatus(
  options: { webhookUrl?: string; operatorRouteConfigured?: boolean } = {}
): OpsAlertChannelStatus {
  const webhookConfigured = Boolean(
    (options.webhookUrl ?? process.env[OPS_ALERT_WEBHOOK_ENV] ?? '').trim()
  );
  const operatorRouteConfigured = options.operatorRouteConfigured ?? false;
  return {
    configured: webhookConfigured || operatorRouteConfigured,
    webhook_configured: webhookConfigured,
    operator_route_configured: operatorRouteConfigured,
    env_var: OPS_ALERT_WEBHOOK_ENV,
  };
}

function ensureParent(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
}

function postOpsAlertWebhook(payload: string, webhookUrl: string): void {
  safeExec(
    'curl',
    ['-fsS', '-X', 'POST', '-H', 'Content-Type: application/json', '--data', payload, webhookUrl],
    { timeoutMs: 2_000, maxOutputMB: 1 }
  );
}

function renderWebhookPayload(input: OpsAlertInput, id: string, timestamp: string): string {
  return JSON.stringify({
    text: `[${input.severity.toUpperCase()}] ${input.title}`,
    id,
    timestamp,
    severity: input.severity,
    title: input.title,
    context: input.context,
    recommendation: input.recommendation,
    options: input.options ?? [],
  });
}

function recordUndeliveredOpsAlert(
  alertLogPath: string,
  input: OpsAlertInput,
  id: string,
  timestamp: string,
  reason: string
): void {
  // Keep the delivery failure in the same append-only queue consumed by
  // `ops:alerts --redeliver`. The original ops_alert record remains the audit
  // event; this companion record is the retryable delivery envelope.
  appendJsonLine(alertLogPath, {
    ts: timestamp,
    kind: 'operator_notification_undelivered',
    event: 'ops_alert',
    title: input.title,
    reason,
    correlation_id: id,
    alert_id: id,
    severity: input.severity,
    context: input.context,
    recommendation: input.recommendation,
    options: input.options ?? [],
  });
}

export function sendOpsAlert(input: OpsAlertInput, options: OpsAlertOptions = {}): OpsAlertReceipt {
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();
  const key = input.dedupe_key ?? `${input.severity}:${input.title}`;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const prior = lastSentAt.get(key);
  const suppressed = prior !== undefined && now.getTime() - prior < minIntervalMs;
  const id = `${timestamp.replace(/[:.]/g, '-')}-${key.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
  const alertLogPath = options.alertLogPath ?? defaultAlertLogPath();
  ensureParent(alertLogPath);

  const record = {
    id,
    timestamp,
    suppressed,
    ...input,
  };
  appendJsonLine(alertLogPath, record);

  if (suppressed) {
    return {
      id,
      recorded_path: alertLogPath,
      webhook_attempted: false,
      webhook_delivered: false,
      operator_attempted: false,
      operator_delivered: false,
      suppressed: true,
    };
  }
  lastSentAt.set(key, now.getTime());

  const webhookUrl = options.webhookUrl ?? process.env[OPS_ALERT_WEBHOOK_ENV];
  if (!webhookUrl) {
    const operatorRoute = resolveOperatorNotificationRoute(
      'ops_alert',
      loadNotificationPreferences()
    );
    if (operatorRoute && operatorRoute !== 'mute') {
      const operatorDelivered = notifyOperatorSync('ops_alert', {
        title: input.title,
        body: `${input.recommendation}\n${JSON.stringify(input.context)}`,
        correlation_id: id,
      });
      return {
        id,
        recorded_path: alertLogPath,
        webhook_attempted: false,
        webhook_delivered: false,
        operator_attempted: true,
        operator_delivered: operatorDelivered,
        suppressed: false,
      };
    }
    if (operatorRoute === 'mute') {
      return {
        id,
        recorded_path: alertLogPath,
        webhook_attempted: false,
        webhook_delivered: false,
        operator_attempted: false,
        operator_delivered: false,
        suppressed: false,
      };
    }
    recordUndeliveredOpsAlert(alertLogPath, input, id, timestamp, 'no_channel_configured');
    return {
      id,
      recorded_path: alertLogPath,
      webhook_attempted: false,
      webhook_delivered: false,
      operator_attempted: false,
      operator_delivered: false,
      suppressed: false,
    };
  }

  try {
    postOpsAlertWebhook(renderWebhookPayload(input, id, timestamp), webhookUrl);
    return {
      id,
      recorded_path: alertLogPath,
      webhook_attempted: true,
      webhook_delivered: true,
      operator_attempted: false,
      operator_delivered: false,
      suppressed: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[ops-alert] webhook delivery failed: ${message}`);
    recordUndeliveredOpsAlert(
      alertLogPath,
      input,
      id,
      timestamp,
      `delivery_failed:${message.slice(0, 200)}`
    );
    return {
      id,
      recorded_path: alertLogPath,
      webhook_attempted: true,
      webhook_delivered: false,
      operator_attempted: false,
      operator_delivered: false,
      suppressed: false,
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// LC-02a: ops-alert log triage (summary / ack / redeliver)
//
// The JSONL sink is append-only history. Two record shapes accumulated there
// before this module owned triage:
//   - sendOpsAlert records: { id, timestamp, severity, title, ... }
//   - operator-notifications.ts undelivered records:
//     { ts, kind: 'operator_notification_undelivered', event, title, reason }
// Triage never rewrites existing lines. Acknowledgements and redelivery
// receipts are new appended records that reference originals by `ref` —
// the original `id` when present, else a fingerprint of the raw line.
// ---------------------------------------------------------------------------

export type OpsAlertLogRecordKind =
  | 'ops_alert'
  | 'operator_notification_undelivered'
  | 'ops_alert_redelivery'
  | 'ops_alert_ack'
  | 'unknown';

export interface ParsedOpsAlertRecord {
  /** Stable reference: record `id` when present, else a raw-line fingerprint. */
  ref: string;
  kind: OpsAlertLogRecordKind;
  /** Epoch ms parsed from `timestamp` or `ts`; null when absent/invalid. */
  timestampMs: number | null;
  raw: Record<string, unknown>;
}

export function fingerprintOpsAlertLine(line: string): string {
  return `f:${createHash('sha256').update(line).digest('hex').slice(0, 16)}`;
}

function classifyOpsAlertRecord(raw: Record<string, unknown>): OpsAlertLogRecordKind {
  const kind = raw.kind;
  if (
    kind === 'operator_notification_undelivered' ||
    kind === 'ops_alert_redelivery' ||
    kind === 'ops_alert_ack'
  ) {
    return kind;
  }
  if (typeof raw.severity === 'string' && typeof raw.title === 'string') return 'ops_alert';
  return 'unknown';
}

export function parseOpsAlertLog(rawContent: string): ParsedOpsAlertRecord[] {
  const records: ParsedOpsAlertRecord[] = [];
  for (const line of rawContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: Record<string, unknown>;
    try {
      const parsed = parseSafeJsonInput(trimmed, 'ops alert log entry');
      raw =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { value: parsed };
    } catch {
      records.push({
        ref: fingerprintOpsAlertLine(trimmed),
        kind: 'unknown',
        timestampMs: null,
        raw: { unparsable_line: trimmed.slice(0, 200) },
      });
      continue;
    }
    const tsSource =
      typeof raw.timestamp === 'string' ? raw.timestamp : typeof raw.ts === 'string' ? raw.ts : '';
    const timestampMs = tsSource ? Date.parse(tsSource) : Number.NaN;
    records.push({
      ref: typeof raw.id === 'string' && raw.id ? raw.id : fingerprintOpsAlertLine(trimmed),
      kind: classifyOpsAlertRecord(raw),
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
      raw,
    });
  }
  return records;
}

export function readOpsAlertLogRecords(alertLogPath?: string): ParsedOpsAlertRecord[] {
  const filePath = alertLogPath ?? defaultAlertLogPath();
  if (!safeExistsSync(filePath)) return [];
  return parseOpsAlertLog(safeReadFile(filePath, { encoding: 'utf8' }) as string);
}

interface UndeliveredClassification {
  outstanding: ParsedOpsAlertRecord[];
  redelivered: ParsedOpsAlertRecord[];
  acknowledged: ParsedOpsAlertRecord[];
}

function classifyUndelivered(records: ParsedOpsAlertRecord[]): UndeliveredClassification {
  const redeliveredRefs = new Set<string>();
  let ackBeforeMs: number | null = null;
  for (const record of records) {
    if (record.kind === 'ops_alert_redelivery' && record.raw.delivered === true) {
      if (typeof record.raw.ref === 'string') redeliveredRefs.add(record.raw.ref);
    }
    if (record.kind === 'ops_alert_ack' && typeof record.raw.before === 'string') {
      const beforeMs = Date.parse(record.raw.before);
      if (Number.isFinite(beforeMs)) {
        ackBeforeMs = ackBeforeMs === null ? beforeMs : Math.max(ackBeforeMs, beforeMs);
      }
    }
  }
  const outstanding: ParsedOpsAlertRecord[] = [];
  const redelivered: ParsedOpsAlertRecord[] = [];
  const acknowledged: ParsedOpsAlertRecord[] = [];
  for (const record of records) {
    if (record.kind !== 'operator_notification_undelivered') continue;
    if (redeliveredRefs.has(record.ref)) {
      redelivered.push(record);
    } else if (
      ackBeforeMs !== null &&
      record.timestampMs !== null &&
      record.timestampMs <= ackBeforeMs
    ) {
      acknowledged.push(record);
    } else {
      outstanding.push(record);
    }
  }
  return { outstanding, redelivered, acknowledged };
}

export function selectOutstandingUndeliveredOpsAlerts(
  records: ParsedOpsAlertRecord[]
): ParsedOpsAlertRecord[] {
  return classifyUndelivered(records).outstanding;
}

export interface OpsAlertLogSummary {
  total_records: number;
  by_kind: Record<string, number>;
  alerts: { total: number; suppressed: number; by_severity: Record<string, number> };
  undelivered: {
    total: number;
    outstanding: number;
    redelivered: number;
    acknowledged: number;
    by_reason: Record<string, number>;
    by_event: Record<string, number>;
    oldest_outstanding: string | null;
    newest_outstanding: string | null;
  };
  top_categories: { category: string; count: number }[];
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function recordCategory(record: ParsedOpsAlertRecord): string {
  if (record.kind === 'operator_notification_undelivered') {
    return `notification:${typeof record.raw.event === 'string' ? record.raw.event : 'unknown'}`;
  }
  if (typeof record.raw.category === 'string' && record.raw.category) return record.raw.category;
  if (typeof record.raw.dedupe_key === 'string' && record.raw.dedupe_key.includes(':')) {
    return record.raw.dedupe_key.split(':')[0]!;
  }
  return 'uncategorized';
}

function isoOrNull(timestampMs: number | null): string | null {
  return timestampMs === null ? null : new Date(timestampMs).toISOString();
}

export function summarizeOpsAlertLog(records: ParsedOpsAlertRecord[]): OpsAlertLogSummary {
  const byKind: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const byEvent: Record<string, number> = {};
  const categories: Record<string, number> = {};
  let alertTotal = 0;
  let alertSuppressed = 0;
  for (const record of records) {
    increment(byKind, record.kind);
    if (record.kind === 'ops_alert') {
      alertTotal += 1;
      if (record.raw.suppressed === true) alertSuppressed += 1;
      increment(bySeverity, String(record.raw.severity ?? 'unknown'));
      increment(categories, recordCategory(record));
    }
    if (record.kind === 'operator_notification_undelivered') {
      increment(byReason, String(record.raw.reason ?? 'unknown'));
      increment(byEvent, String(record.raw.event ?? 'unknown'));
      increment(categories, recordCategory(record));
    }
  }
  const { outstanding, redelivered, acknowledged } = classifyUndelivered(records);
  const outstandingTimes = outstanding
    .map((record) => record.timestampMs)
    .filter((value): value is number => value !== null);
  // Sort by count desc, then key codepoint asc (never localeCompare — ICU
  // collation differs across platforms and would make output non-reproducible).
  const topCategories = Object.entries(categories)
    .sort(([aKey, aCount], [bKey, bCount]) =>
      bCount !== aCount ? bCount - aCount : aKey < bKey ? -1 : aKey > bKey ? 1 : 0
    )
    .slice(0, 5)
    .map(([category, count]) => ({ category, count }));
  return {
    total_records: records.length,
    by_kind: byKind,
    alerts: { total: alertTotal, suppressed: alertSuppressed, by_severity: bySeverity },
    undelivered: {
      total: outstanding.length + redelivered.length + acknowledged.length,
      outstanding: outstanding.length,
      redelivered: redelivered.length,
      acknowledged: acknowledged.length,
      by_reason: byReason,
      by_event: byEvent,
      oldest_outstanding: isoOrNull(
        outstandingTimes.length > 0 ? Math.min(...outstandingTimes) : null
      ),
      newest_outstanding: isoOrNull(
        outstandingTimes.length > 0 ? Math.max(...outstandingTimes) : null
      ),
    },
    top_categories: topCategories,
  };
}

export interface OpsAlertAckReceipt {
  acked_count: number;
  before: string;
  recorded_path: string;
}

/**
 * Append an acknowledgement record covering every currently-outstanding
 * undelivered notification with a timestamp <= `before` (default: now).
 * History is never rewritten — the summary derives "acknowledged" from the
 * appended record.
 */
export function acknowledgeOpsAlerts(
  options: { before?: string; now?: Date; alertLogPath?: string } = {}
): OpsAlertAckReceipt {
  const now = options.now ?? new Date();
  const before = options.before ?? now.toISOString();
  const beforeMs = Date.parse(before);
  if (!Number.isFinite(beforeMs)) {
    throw new Error(`acknowledgeOpsAlerts: --before is not a valid ISO timestamp: ${before}`);
  }
  if (beforeMs > now.getTime()) {
    throw new Error(
      `acknowledgeOpsAlerts: --before must not be in the future (now=${now.toISOString()})`
    );
  }
  const alertLogPath = options.alertLogPath ?? defaultAlertLogPath();
  const outstanding = selectOutstandingUndeliveredOpsAlerts(
    readOpsAlertLogRecords(alertLogPath)
  ).filter((record) => record.timestampMs !== null && record.timestampMs <= beforeMs);
  ensureParent(alertLogPath);
  appendJsonLine(alertLogPath, {
    ts: now.toISOString(),
    kind: 'ops_alert_ack',
    before,
    acked_count: outstanding.length,
  });
  return { acked_count: outstanding.length, before, recorded_path: alertLogPath };
}

export interface OpsAlertRedeliveryOutcome {
  ref: string;
  title: string;
  delivered: boolean;
  error?: string;
}

export interface OpsAlertRedeliveryReport {
  attempted: number;
  delivered: number;
  failed: number;
  outcomes: OpsAlertRedeliveryOutcome[];
  recorded_path: string;
}

/**
 * Re-send outstanding undelivered notifications through the now-configured
 * webhook channel. Each attempt appends an `ops_alert_redelivery` receipt
 * referencing the original record's `ref` — originals are never mutated.
 */
export function redeliverUndeliveredOpsAlerts(
  options: {
    alertLogPath?: string;
    webhookUrl?: string;
    now?: Date;
    limit?: number;
    deliver?: (payloadJson: string) => void;
  } = {}
): OpsAlertRedeliveryReport {
  const now = options.now ?? new Date();
  const alertLogPath = options.alertLogPath ?? defaultAlertLogPath();
  const webhookUrl = options.webhookUrl ?? process.env[OPS_ALERT_WEBHOOK_ENV];
  const deliver =
    options.deliver ??
    (webhookUrl ? (payload: string) => postOpsAlertWebhook(payload, webhookUrl) : null);
  if (!deliver) {
    throw new Error(
      `redeliverUndeliveredOpsAlerts: no delivery channel configured — set ${OPS_ALERT_WEBHOOK_ENV} before running --redeliver`
    );
  }
  const outstanding = selectOutstandingUndeliveredOpsAlerts(readOpsAlertLogRecords(alertLogPath));
  const batch =
    typeof options.limit === 'number' && options.limit >= 0
      ? outstanding.slice(0, options.limit)
      : outstanding;
  ensureParent(alertLogPath);
  const outcomes: OpsAlertRedeliveryOutcome[] = [];
  for (const record of batch) {
    const title = typeof record.raw.title === 'string' ? record.raw.title : '(untitled)';
    let delivered = true;
    let errorMessage: string | undefined;
    try {
      deliver(
        JSON.stringify({
          text: `[REDELIVERY] ${title}`,
          redelivery_of: record.ref,
          redelivered_at: now.toISOString(),
          original: record.raw,
        })
      );
    } catch (error) {
      delivered = false;
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    appendJsonLine(alertLogPath, {
      ts: now.toISOString(),
      kind: 'ops_alert_redelivery',
      ref: record.ref,
      channel: 'webhook',
      delivered,
      ...(errorMessage ? { error: errorMessage.slice(0, 300) } : {}),
    });
    outcomes.push({
      ref: record.ref,
      title,
      delivered,
      ...(errorMessage ? { error: errorMessage } : {}),
    });
  }
  const deliveredCount = outcomes.filter((outcome) => outcome.delivered).length;
  return {
    attempted: outcomes.length,
    delivered: deliveredCount,
    failed: outcomes.length - deliveredCount,
    outcomes,
    recorded_path: alertLogPath,
  };
}
