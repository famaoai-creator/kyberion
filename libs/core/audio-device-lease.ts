import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  safeCreateExclusiveFileSync,
  safeExistsSync,
  safeReadFile,
  safeUnlink,
  safeWriteFile,
} from './secure-io.js';
import * as pathResolver from './path-resolver.js';

export interface AudioDeviceLeaseRecord {
  lease_id: string;
  device_uid: string;
  pid: number;
  session_id: string;
  acquired_at: string;
  expires_at: string;
  heartbeat_at: string;
}

export interface AudioDeviceLease {
  readonly record: AudioDeviceLeaseRecord;
  heartbeat(): void;
  release(): void;
}

export interface AudioDeviceLeaseManagerOptions {
  lease_dir?: string;
  now?: () => number;
  pid?: number;
}

const localLeases = new Set<string>();

export class AudioDeviceLeaseManager {
  private readonly leaseDir: string;
  private readonly now: () => number;
  private readonly pid: number;

  constructor(options: AudioDeviceLeaseManagerOptions = {}) {
    this.leaseDir = options.lease_dir ?? pathResolver.shared('runtime/audio-leases');
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
  }

  acquire(deviceUid: string, sessionId: string, ttlMs = 30_000): AudioDeviceLease {
    const uid = deviceUid.trim();
    const session = sessionId.trim();
    if (!uid || !session) throw new Error('audio device lease requires device_uid and session_id');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0)
      throw new Error('audio device lease ttl must be positive');
    const lockPath = this.lockPath(uid);
    if (localLeases.has(lockPath))
      throw new Error(`audio device '${uid}' is already leased in this process`);
    const nowMs = this.now();
    const record: AudioDeviceLeaseRecord = {
      lease_id: randomUUID(),
      device_uid: uid,
      pid: this.pid,
      session_id: session,
      acquired_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + ttlMs).toISOString(),
      heartbeat_at: new Date(nowMs).toISOString(),
    };
    try {
      safeCreateExclusiveFileSync(lockPath, JSON.stringify(record, null, 2));
    } catch (error) {
      if (!safeExistsSync(lockPath) || !this.isStale(lockPath)) {
        throw new Error(`audio device '${uid}' is already leased`);
      }
      safeUnlink(lockPath);
      safeCreateExclusiveFileSync(lockPath, JSON.stringify(record, null, 2));
    }
    localLeases.add(lockPath);
    let released = false;
    return {
      record,
      heartbeat: () => {
        if (released) return;
        const currentMs = this.now();
        const next = {
          ...record,
          heartbeat_at: new Date(currentMs).toISOString(),
          expires_at: new Date(currentMs + ttlMs).toISOString(),
        };
        record.heartbeat_at = next.heartbeat_at;
        record.expires_at = next.expires_at;
        safeWriteFile(lockPath, JSON.stringify(next, null, 2));
      },
      release: () => {
        if (released) return;
        released = true;
        localLeases.delete(lockPath);
        safeUnlink(lockPath);
      },
    };
  }

  private lockPath(uid: string): string {
    const digest = createHash('sha256').update(uid).digest('hex').slice(0, 32);
    return path.join(this.leaseDir, `${digest}.json`);
  }

  private isStale(lockPath: string): boolean {
    try {
      const parsed: unknown = JSON.parse(String(safeReadFile(lockPath, { encoding: 'utf8' })));
      if (!isRecord(parsed) || typeof parsed.expires_at !== 'string') return true;
      return Date.parse(parsed.expires_at) <= this.now();
    } catch {
      return true;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
