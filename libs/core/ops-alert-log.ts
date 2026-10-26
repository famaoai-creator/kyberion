import * as path from 'node:path';
import { appendJsonLine } from './foundation/json.js';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  withSafeAppendFile,
} from './secure-io.js';
import { withOperationalAlertStore } from './foundation/operational-store-policy.js';

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
