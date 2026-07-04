import { safeAppendFileSync, safeExec, safeMkdir, safeExistsSync } from './secure-io.js';
import * as pathResolver from './path-resolver.js';
import { logger } from './core.js';
import * as path from 'node:path';

export type OpsAlertSeverity = 'info' | 'warning' | 'critical';

export interface OpsAlertInput {
  severity: OpsAlertSeverity;
  title: string;
  context: Record<string, unknown>;
  recommendation: string;
  options?: string[];
  dedupe_key?: string;
}

export interface OpsAlertReceipt {
  id: string;
  recorded_path: string;
  webhook_attempted: boolean;
  webhook_delivered: boolean;
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

function defaultAlertLogPath(): string {
  return pathResolver.shared('observability/ops-alerts.jsonl');
}

function ensureParent(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
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
  safeAppendFileSync(alertLogPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });

  if (suppressed) {
    return {
      id,
      recorded_path: alertLogPath,
      webhook_attempted: false,
      webhook_delivered: false,
      suppressed: true,
    };
  }
  lastSentAt.set(key, now.getTime());

  const webhookUrl = options.webhookUrl ?? process.env.KYBERION_OPS_ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    return {
      id,
      recorded_path: alertLogPath,
      webhook_attempted: false,
      webhook_delivered: false,
      suppressed: false,
    };
  }

  try {
    safeExec(
      'curl',
      [
        '-fsS',
        '-X',
        'POST',
        '-H',
        'Content-Type: application/json',
        '--data',
        renderWebhookPayload(input, id, timestamp),
        webhookUrl,
      ],
      { timeoutMs: 10_000, maxOutputMB: 1 }
    );
    return {
      id,
      recorded_path: alertLogPath,
      webhook_attempted: true,
      webhook_delivered: true,
      suppressed: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[ops-alert] webhook delivery failed: ${message}`);
    return {
      id,
      recorded_path: alertLogPath,
      webhook_attempted: true,
      webhook_delivered: false,
      suppressed: false,
      error: message,
    };
  }
}
