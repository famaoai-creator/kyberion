import * as path from 'node:path';
import { appendJsonLine, loadJsonIfPresent, writeJson } from '../foundation/json.js';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  withSafeAppendFile,
} from '../secure-io.js';
import { withOperationalAlertStore } from '../foundation/operational-store-policy.js';
import { logger } from '../core.js';

/** Elevation is limited to the two fixed store files; custom paths retain caller rights. */
export function withOpsAlertFileStore<T>(filePath: string, fn: () => T): T {
  const canonical = path.resolve(filePath);
  const logPath = pathResolver.shared('observability/ops-alerts.jsonl');
  return [logPath, logPath.replace(/\.jsonl$/, '.dedupe.json')].some(
    (file) => canonical === path.resolve(file)
  )
    ? withOperationalAlertStore(fn)
    : fn();
}

const OPS_ALERT_LOG_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/ops-alert-log-record.schema.json'
);

function catalog(filePath: string): GovernedCatalog<Record<string, unknown>> {
  return defineCatalog<Record<string, unknown>>({
    id: 'ops-alert-log-record',
    path: filePath,
    schema: OPS_ALERT_LOG_SCHEMA_PATH,
  });
}

export function resolveOpsAlertLogPath(filePath: string): string {
  return assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
}

export function ensureRegularOpsAlertLogFile(filePath: string): void {
  if (safeExistsSync(filePath) && !safeLstat(filePath).isFile()) {
    throw new Error(`[OPS_ALERT_LOG_INVALID] log must be a regular file: ${filePath}`);
  }
}

export function validateOpsAlertLogRecord(
  value: unknown,
  filePath: string
): Record<string, unknown> {
  const safeFilePath = resolveOpsAlertLogPath(filePath);
  return catalog(safeFilePath).validate(value, safeFilePath);
}

export function appendOpsAlertLogRecord(filePath: string, value: unknown): string {
  return withOpsAlertFileStore(filePath, () => appendScopedOpsAlertLogRecord(filePath, value));
}

function appendScopedOpsAlertLogRecord(filePath: string, value: unknown): string {
  const safeFilePath = resolveOpsAlertLogPath(filePath);
  // Authorize the exact store file; the append helper creates its parents under
  // that checked destination without granting a writable directory prefix.
  if (!safeExistsSync(path.dirname(safeFilePath))) {
    withSafeAppendFile(safeFilePath, () => undefined);
  }
  ensureRegularOpsAlertLogFile(safeFilePath);
  appendJsonLine(safeFilePath, catalog(safeFilePath).validate(value, safeFilePath));
  return safeFilePath;
}

/**
 * MSN-LOG-STORE-HARDENING-20261016: dedupe state persisted across processes,
 * living next to the alert log as `ops-alerts.dedupe.json`. The state file is
 * the shared source of truth for every emitter (ops-alert.ts sendOpsAlert and
 * the notification path's delivery-gap companion alike) so short-lived
 * processes dedupe against sends made by other processes.
 */
export const OPS_ALERT_DEDUPE_STATE_FILENAME = 'ops-alerts.dedupe.json';
export const OPS_ALERT_DEDUPE_STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Dedupe state lives next to the alert log: `ops-alerts.dedupe.json`. */
export function opsAlertDedupeStatePathFor(alertLogPath: string): string {
  return alertLogPath.replace(/\.jsonl$/, '.dedupe.json');
}

/** Load `key -> last-sent epochMs`, pruning entries older than 30 days. */
export function loadOpsAlertDedupeState(filePath: string, nowMs: number): Map<string, number> {
  const state = new Map<string, number>();
  const raw = withOpsAlertFileStore(filePath, () =>
    loadJsonIfPresent<Record<string, unknown>>(filePath)
  );
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (nowMs - value > OPS_ALERT_DEDUPE_STATE_MAX_AGE_MS) continue;
    state.set(key, value);
  }
  return state;
}

/** Best-effort persist — dedupe persistence must never break alerting. */
export function persistOpsAlertDedupeState(filePath: string, state: Map<string, number>): void {
  try {
    withOpsAlertFileStore(filePath, () => writeJson(filePath, Object.fromEntries(state)));
  } catch (err) {
    logger.debug(
      `[ops-alert] failed to persist dedupe state: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
