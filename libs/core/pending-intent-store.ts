import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeReaddir, safeRmSync, safeWriteFile } from './secure-io.js';
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

function normalizeSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'pending';
}

export function getPendingIntentPath(correlationId: string): string {
  return pathResolver.sharedTmp(path.join(PENDING_INTENT_SUBDIR, `${normalizeSegment(correlationId)}.json`));
}

function ensurePendingIntentDir(): void {
  const dir = pathResolver.sharedTmp(PENDING_INTENT_SUBDIR);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
}

function isExpired(record: PendingIntentRecord, now = Date.now()): boolean {
  const expiresAt = Date.parse(record.expires_at);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function normalizePendingIntent(value: unknown): PendingIntentRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as PendingIntentRecord;
  if (
    record.kind !== 'pending-intent' ||
    typeof record.correlation_id !== 'string' ||
    typeof record.created_at !== 'string' ||
    typeof record.updated_at !== 'string' ||
    typeof record.expires_at !== 'string' ||
    typeof record.source_text !== 'string'
  ) {
    return null;
  }
  const requiredInputs = Array.isArray(record.required_inputs)
    ? record.required_inputs.map((item) => String(item).trim()).filter(Boolean)
    : [];
  return {
    ...record,
    required_inputs: requiredInputs,
  };
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
  const now = new Date().toISOString();
  const ttlMs = Math.max(60_000, input.ttlMs ?? DEFAULT_TTL_MS);
  const record: PendingIntentRecord = {
    kind: 'pending-intent',
    correlation_id: input.correlation_id,
    created_at: input.created_at || now,
    updated_at: input.updated_at || now,
    expires_at: input.expires_at || new Date(Date.now() + ttlMs).toISOString(),
    source_text: input.source_text,
    intent_id: input.intent_id,
    required_inputs: Array.from(new Set(input.required_inputs.map((item) => String(item).trim()).filter(Boolean))),
    source_surface: input.source_surface,
    thread_context: input.thread_context,
    clarification_packet: input.clarification_packet,
    runtime_context: input.runtime_context,
  };
  safeWriteFile(getPendingIntentPath(record.correlation_id), JSON.stringify(record, null, 2));
  return record;
}

export function loadPendingIntent(correlationId: string): PendingIntentRecord | null {
  const filePath = getPendingIntentPath(correlationId);
  if (!safeExistsSync(filePath)) return null;
  let parsed: PendingIntentRecord | null = null;
  try {
    parsed = normalizePendingIntent(
      JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string)
    );
  } catch {
    clearPendingIntent(correlationId);
    return null;
  }
  if (!parsed) {
    clearPendingIntent(correlationId);
    return null;
  }
  if (isExpired(parsed)) {
    clearPendingIntent(correlationId);
    return null;
  }
  return parsed;
}

export function clearPendingIntent(correlationId: string): void {
  const filePath = getPendingIntentPath(correlationId);
  if (!safeExistsSync(filePath)) return;
  safeRmSync(filePath, { force: true });
}

export function listPendingIntents(): PendingIntentRecord[] {
  const dir = pathResolver.sharedTmp(PENDING_INTENT_SUBDIR);
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadPendingIntent(entry.replace(/\.json$/, '')))
    .filter((entry): entry is PendingIntentRecord => Boolean(entry));
}
