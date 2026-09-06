import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import type { OperatorInteractionPacket } from './src/types/operator-interaction-packet.js';

export interface PendingIntentRecord {
  kind: 'pending-intent';
  correlation_id: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  source_text: string;
  intent_id?: string;
  required_inputs: string[];
  source_surface?: string;
  thread_context?: string;
  clarification_packet?: OperatorInteractionPacket;
  runtime_context?: Record<string, unknown>;
}

const PENDING_INTENT_SUBDIR = 'pending-intents';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_INTENT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/pending-intent.schema.json'
);

const pendingIntentCatalog = defineCatalog<PendingIntentRecord>({
  id: 'pending-intent',
  path: PENDING_INTENT_SCHEMA_PATH,
  schema: PENDING_INTENT_SCHEMA_PATH,
});

function pendingIntentCatalogAtPath(filePath: string) {
  return defineCatalog<PendingIntentRecord>({
    id: 'pending-intent',
    path: filePath,
    schema: PENDING_INTENT_SCHEMA_PATH,
  });
}

function normalizeSegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'pending'
  );
}

export function getPendingIntentPath(correlationId: string): string {
  return assertSafeRepositoryPath(
    pathResolver.sharedTmp(
      path.join(PENDING_INTENT_SUBDIR, `${normalizeSegment(correlationId)}.json`)
    ),
    { allowMissingLeaf: true }
  );
}

function ensurePendingIntentDir(): void {
  const dir = assertSafeRepositoryPath(pathResolver.sharedTmp(PENDING_INTENT_SUBDIR), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
}

function isExpired(record: PendingIntentRecord, now = Date.now()): boolean {
  const expiresAt = Date.parse(record.expires_at);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function normalizePendingIntent(value: unknown): PendingIntentRecord | null {
  try {
    const record = pendingIntentCatalog.validate(value, 'pending intent');
    return {
      ...record,
      required_inputs: Array.from(
        new Set(record.required_inputs.map((item) => item.trim()).filter(Boolean))
      ),
    };
  } catch {
    return null;
  }
}

export function savePendingIntent(
  input: Omit<PendingIntentRecord, 'kind' | 'created_at' | 'updated_at' | 'expires_at'> & {
    created_at?: string;
    updated_at?: string;
    expires_at?: string;
    ttlMs?: number;
  }
): PendingIntentRecord {
  ensurePendingIntentDir();
  const ttlMs = Math.max(60_000, input.ttlMs ?? DEFAULT_TTL_MS);
  const currentTime = new Date();
  const now = nowIso(currentTime);
  const record: PendingIntentRecord = {
    kind: 'pending-intent',
    correlation_id: input.correlation_id,
    created_at: input.created_at || now,
    updated_at: input.updated_at || now,
    expires_at: input.expires_at || nowIso(new Date(currentTime.getTime() + ttlMs)),
    source_text: input.source_text,
    intent_id: input.intent_id,
    required_inputs: Array.from(
      new Set(input.required_inputs.map((item) => String(item).trim()).filter(Boolean))
    ),
    source_surface: input.source_surface,
    thread_context: input.thread_context,
    clarification_packet: input.clarification_packet,
    runtime_context: input.runtime_context,
  };
  const filePath = getPendingIntentPath(record.correlation_id);
  const validated = pendingIntentCatalog.validate(record, filePath);
  safeWriteFile(filePath, JSON.stringify(validated, null, 2));
  return validated;
}

/** Load one persisted pending intent through schema, regular-file, and correlation binding. */
export function loadPendingIntentAtPath(
  filePath: string,
  expectedCorrelationId?: string
): PendingIntentRecord {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[PENDING_INTENT] record must be a regular file: ${filePath}`);
  }
  const record = normalizePendingIntent(pendingIntentCatalogAtPath(safeFilePath).load());
  if (!record) throw new Error(`[PENDING_INTENT] invalid record at ${filePath}`);
  if (expectedCorrelationId !== undefined && record.correlation_id !== expectedCorrelationId) {
    throw new Error(
      `[PENDING_INTENT_SCOPE_MISMATCH] record belongs to ${record.correlation_id}, expected ${expectedCorrelationId}`
    );
  }
  return record;
}

export function loadPendingIntent(correlationId: string): PendingIntentRecord | null {
  const filePath = getPendingIntentPath(correlationId);
  if (!safeExistsSync(filePath)) return null;
  try {
    const parsed = loadPendingIntentAtPath(filePath, correlationId);
    if (isExpired(parsed)) {
      clearPendingIntent(correlationId);
      return null;
    }
    return parsed;
  } catch {
    try {
      clearPendingIntent(correlationId);
    } catch {
      // A malformed path is non-blocking; the next janitor pass can remove it.
    }
    return null;
  }
}

export function clearPendingIntent(correlationId: string): void {
  const filePath = getPendingIntentPath(correlationId);
  if (!safeExistsSync(filePath)) return;
  safeRmSync(filePath, { force: true });
}

export function listPendingIntents(): PendingIntentRecord[] {
  const dir = assertSafeRepositoryPath(pathResolver.sharedTmp(PENDING_INTENT_SUBDIR), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadPendingIntent(entry.replace(/\.json$/, '')))
    .filter((entry): entry is PendingIntentRecord => Boolean(entry));
}
