import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import {
  safeCreateExclusiveFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';

export type DeliverableInboxStatus =
  | 'unread'
  | 'read'
  | 'accepted'
  | 'rejected'
  | 'changes_requested';

export interface DeliverableInboxEntry {
  entry_id: string;
  mission_id?: string;
  title: string;
  artifact_paths: string[];
  summary: string;
  created_at: string;
  updated_at: string;
  status: DeliverableInboxStatus;
  tenant_slug?: string;
  kind?: string;
  /** SU-03: reviewer note attached with a rejected / changes_requested verdict. */
  verdict_note?: string;
  /** SU-03: who recorded the latest verdict. */
  reviewed_by?: string;
}

export interface DeliverableInboxQuery {
  query?: string;
  missionId?: string;
  tenant?: string;
  status?: DeliverableInboxStatus | DeliverableInboxStatus[] | string | string[];
  limit?: number;
}

const INBOX_PATH = pathResolver.shared(path.join('inbox', 'entries.jsonl'));
const INBOX_LOCK_PATH = `${INBOX_PATH}.lock`;
const LOCK_TIMEOUT_MS = 5000;

function ensureInboxDir(): void {
  safeMkdir(path.dirname(INBOX_PATH), { recursive: true });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isStaleLock(lockPath: string): boolean {
  try {
    const raw = String(safeReadFile(lockPath, { encoding: 'utf8' }) || '');
    const parsed = JSON.parse(raw) as { pid?: number };
    if (typeof parsed.pid !== 'number') return true;
    process.kill(parsed.pid, 0);
    return false;
  } catch (error: any) {
    if (error?.code === 'ESRCH') return true;
    if (error?.code === 'EPERM') return false;
    return true;
  }
}

function withInboxLock<T>(fn: () => T): T {
  ensureInboxDir();
  const startedAt = Date.now();
  let ownsLock = false;

  while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
    try {
      safeCreateExclusiveFileSync(
        INBOX_LOCK_PATH,
        JSON.stringify({
          pid: process.pid,
          created_at: new Date().toISOString(),
          resource: 'deliverable-inbox',
        })
      );
      ownsLock = true;
      break;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      if (isStaleLock(INBOX_LOCK_PATH)) {
        safeUnlinkSync(INBOX_LOCK_PATH);
        continue;
      }
      sleepSync(50 + Math.floor(Math.random() * 50));
    }
  }

  if (!ownsLock) {
    throw new Error(`[LOCK_TIMEOUT] Failed to acquire inbox lock within ${LOCK_TIMEOUT_MS}ms`);
  }

  try {
    return fn();
  } finally {
    safeUnlinkSync(INBOX_LOCK_PATH);
  }
}

function parseEntry(line: string): DeliverableInboxEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as DeliverableInboxEntry;
    if (!parsed || typeof parsed.entry_id !== 'string') return null;
    if (!Array.isArray(parsed.artifact_paths)) parsed.artifact_paths = [];
    if (typeof parsed.status !== 'string') parsed.status = 'unread';
    if (typeof parsed.created_at !== 'string') parsed.created_at = new Date().toISOString();
    if (typeof parsed.updated_at !== 'string') parsed.updated_at = parsed.created_at;
    if (typeof parsed.title !== 'string') parsed.title = parsed.entry_id;
    if (typeof parsed.summary !== 'string') parsed.summary = '';
    return parsed;
  } catch {
    return null;
  }
}

function readInboxEntries(): DeliverableInboxEntry[] {
  if (!safeExistsSync(INBOX_PATH)) return [];
  const raw = String(safeReadFile(INBOX_PATH, { encoding: 'utf8' }) || '');
  return raw
    .split(/\r?\n/u)
    .map(parseEntry)
    .filter((entry): entry is DeliverableInboxEntry => Boolean(entry));
}

function writeInboxEntries(entries: DeliverableInboxEntry[]): void {
  ensureInboxDir();
  const serialized = entries.map((entry) => JSON.stringify(entry)).join('\n');
  safeWriteFile(INBOX_PATH, serialized ? `${serialized}\n` : '');
}

function normalizeStatusFilter(
  status?: DeliverableInboxQuery['status']
): Set<DeliverableInboxStatus> | null {
  if (!status) return null;
  const values = Array.isArray(status) ? status : [status];
  return new Set(
    values
      .map((value) => String(value).trim().toLowerCase())
      .filter(
        (value): value is DeliverableInboxStatus =>
          value === 'unread' ||
          value === 'read' ||
          value === 'accepted' ||
          value === 'rejected' ||
          value === 'changes_requested'
      )
  );
}

function collectSearchText(entry: DeliverableInboxEntry): string {
  return [
    entry.entry_id,
    entry.mission_id,
    entry.title,
    entry.summary,
    entry.tenant_slug,
    entry.kind,
    ...entry.artifact_paths,
    entry.status,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();
}

export function addInboxEntry(input: {
  missionId?: string;
  title: string;
  artifactPaths?: string[];
  summary?: string;
  tenantSlug?: string;
  kind?: string;
  status?: DeliverableInboxStatus;
  entryId?: string;
  createdAt?: string;
}): DeliverableInboxEntry {
  const now = new Date().toISOString();
  const entry: DeliverableInboxEntry = {
    entry_id: input.entryId || `INBOX-${randomUUID().slice(0, 8).toUpperCase()}`,
    mission_id: input.missionId?.trim() || undefined,
    title: input.title.trim() || input.missionId?.trim() || 'Deliverable',
    artifact_paths: Array.from(
      new Set(
        (input.artifactPaths || []).map((artifact) => String(artifact).trim()).filter(Boolean)
      )
    ),
    summary: input.summary?.trim() || '',
    created_at: input.createdAt || now,
    updated_at: input.createdAt || now,
    status: input.status || 'unread',
    tenant_slug: input.tenantSlug?.trim() || undefined,
    kind: input.kind?.trim() || undefined,
  };

  return withInboxLock(() => {
    const entries = readInboxEntries();
    entries.push(entry);
    writeInboxEntries(entries);
    return entry;
  });
}

export function listInboxEntries(query: DeliverableInboxQuery = {}): DeliverableInboxEntry[] {
  const statusFilter = normalizeStatusFilter(query.status);
  const missionFilter = query.missionId?.trim().toUpperCase() || '';
  const tenantFilter = query.tenant?.trim().toLowerCase() || '';
  const textFilter = query.query?.trim().toLowerCase() || '';
  const entries = readInboxEntries().filter((entry) => {
    if (statusFilter && !statusFilter.has(entry.status)) return false;
    if (missionFilter && entry.mission_id?.toUpperCase() !== missionFilter) return false;
    if (
      tenantFilter &&
      !`${entry.tenant_slug || ''} ${entry.summary} ${entry.title}`
        .toLowerCase()
        .includes(tenantFilter)
    ) {
      return false;
    }
    if (textFilter && !collectSearchText(entry).includes(textFilter)) return false;
    return true;
  });

  return entries
    .sort((left, right) => {
      const leftTime = left.updated_at || left.created_at;
      const rightTime = right.updated_at || right.created_at;
      return rightTime.localeCompare(leftTime);
    })
    .slice(0, Math.max(1, query.limit || 50));
}

export function markInboxEntry(
  entryId: string,
  status: DeliverableInboxStatus,
  options: { verdictNote?: string; reviewedBy?: string } = {}
): DeliverableInboxEntry | null {
  const normalizedId = String(entryId || '').trim();
  if (!normalizedId) return null;
  return withInboxLock(() => {
    const entries = readInboxEntries();
    const index = entries.findIndex((entry) => entry.entry_id === normalizedId);
    if (index < 0) return null;
    const verdictNote = options.verdictNote?.trim();
    const reviewedBy = options.reviewedBy?.trim();
    entries[index] = {
      ...entries[index],
      status,
      ...(verdictNote ? { verdict_note: verdictNote } : {}),
      ...(reviewedBy ? { reviewed_by: reviewedBy } : {}),
      updated_at: new Date().toISOString(),
    };
    writeInboxEntries(entries);
    return entries[index];
  });
}
