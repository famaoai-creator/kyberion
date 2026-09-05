import * as path from 'node:path';
import { appendJsonLine } from './foundation/json.js';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
} from './secure-io.js';

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
  const safeFilePath = resolveOpsAlertLogPath(filePath);
  const parent = path.dirname(safeFilePath);
  if (!safeExistsSync(parent)) safeMkdir(parent, { recursive: true });
  ensureRegularOpsAlertLogFile(safeFilePath);
  appendJsonLine(safeFilePath, catalog(safeFilePath).validate(value, safeFilePath));
  return safeFilePath;
}

export function readOpsAlertLogText(filePath: string): { path: string; text: string } | null {
  const safeFilePath = resolveOpsAlertLogPath(filePath);
  if (!safeExistsSync(safeFilePath)) return null;
  ensureRegularOpsAlertLogFile(safeFilePath);
  return { path: safeFilePath, text: safeReadFile(safeFilePath, { encoding: 'utf8' }) as string };
}
