import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  assertSafeRepositoryPath,
  safeCreateExclusiveFileSync,
  safeExistsSync,
  safeLstat,
  safeReadFile,
  safeUnlink,
  safeWriteFile,
} from './secure-io.js';
import * as pathResolver from './path-resolver.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';

export interface VideoDeviceLeaseRecord {
  lease_id: string;
  device_uid: string;
  pid: number;
  session_id: string;
  acquired_at: string;
  expires_at: string;
  heartbeat_at: string;
}

export interface VideoDeviceLease {
  readonly record: VideoDeviceLeaseRecord;
  heartbeat(): void;
  release(): void;
}

export interface VideoDeviceLeaseManagerOptions {
  lease_dir?: string;
  now?: () => number;
  pid?: number;
}

const KNOWN_KEYS = new Set([
  'lease_id',
  'device_uid',
  'pid',
  'session_id',
  'acquired_at',
  'expires_at',
  'heartbeat_at',
]);

function validateRecord(value: unknown): VideoDeviceLeaseRecord {
  const record = value as VideoDeviceLeaseRecord;
  if (!record || typeof record !== 'object') throw new Error('invalid video device lease record');
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`video device lease record has unknown field ${key}`);
  }
  for (const key of [
    'lease_id',
    'device_uid',
    'session_id',
    'acquired_at',
    'expires_at',
    'heartbeat_at',
  ] as const) {
    if (typeof record[key] !== 'string' || record[key].trim() === '') {
      throw new Error(`video device lease record requires ${key}`);
    }
  }
  if (!Number.isInteger(record.pid) || record.pid < 1) {
    throw new Error('video device lease record requires pid');
  }
  if (!Number.isFinite(Date.parse(record.expires_at))) {
    throw new Error('video device lease record requires a valid expires_at');
  }
  return record;
}

function readLeaseRecord(lockPath: string): VideoDeviceLeaseRecord | null {
  try {
    if (!safeLstat(lockPath).isFile()) return null;
    return validateRecord(
      parseSafeJsonInput(
        String(safeReadFile(lockPath, { encoding: 'utf8' })),
        'video device lease record'
      )
    );
  } catch {
    return null;
  }
}

const localLeases = new Set<string>();

export class VideoDeviceLeaseManager {
  private readonly leaseDir: string;
  private readonly now: () => number;
  private readonly pid: number;

  constructor(options: VideoDeviceLeaseManagerOptions = {}) {
    this.leaseDir = assertSafeRepositoryPath(
      options.lease_dir ?? pathResolver.shared('runtime/video-leases'),
      { allowMissingLeaf: true }
    );
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
  }

  acquire(deviceUid: string, sessionId: string, ttlMs = 30_000): VideoDeviceLease {
    const uid = deviceUid.trim();
    const session = sessionId.trim();
    if (!uid || !session) throw new Error('video device lease requires device_uid and session_id');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0)
      throw new Error('video device lease ttl must be positive');
    const lockPath = this.lockPath(uid);
    if (localLeases.has(lockPath))
      throw new Error(`video device '${uid}' is already leased in this process`);
    const nowMs = this.now();
    const record: VideoDeviceLeaseRecord = {
      lease_id: randomUUID(),
      device_uid: uid,
      pid: this.pid,
      session_id: session,
      acquired_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + ttlMs).toISOString(),
      heartbeat_at: new Date(nowMs).toISOString(),
    };
    try {
      validateRecord(record);
      safeCreateExclusiveFileSync(lockPath, JSON.stringify(record, null, 2));
    } catch (error) {
      if (!safeExistsSync(lockPath) || !this.isStale(lockPath)) {
        throw new Error(`video device '${uid}' is already leased`);
      }
      safeUnlink(lockPath);
      safeCreateExclusiveFileSync(lockPath, JSON.stringify(record, null, 2));
    }
    localLeases.add(lockPath);
    let released = false;
    const leaseLostError = () => new Error(`video device lease '${uid}' was lost`);
    const assertOwned = (): void => {
      const current = readLeaseRecord(lockPath);
      if (!current || current.lease_id !== record.lease_id) {
        released = true;
        localLeases.delete(lockPath);
        throw leaseLostError();
      }
    };
    return {
      record,
      heartbeat: () => {
        if (released) return;
        assertOwned();
        const currentMs = this.now();
        const next = {
          ...record,
          heartbeat_at: new Date(currentMs).toISOString(),
          expires_at: new Date(currentMs + ttlMs).toISOString(),
        };
        validateRecord(next);
        safeWriteFile(lockPath, JSON.stringify(next, null, 2));
        record.heartbeat_at = next.heartbeat_at;
        record.expires_at = next.expires_at;
      },
      release: () => {
        if (released) return;
        released = true;
        localLeases.delete(lockPath);
        const current = readLeaseRecord(lockPath);
        if (current?.lease_id === record.lease_id) safeUnlink(lockPath);
      },
    };
  }

  private lockPath(uid: string): string {
    const digest = createHash('sha256').update(uid).digest('hex').slice(0, 32);
    return path.join(this.leaseDir, `${digest}.json`);
  }

  private isStale(lockPath: string): boolean {
    const parsed = readLeaseRecord(lockPath);
    return !parsed || Date.parse(parsed.expires_at) <= this.now();
  }
}
