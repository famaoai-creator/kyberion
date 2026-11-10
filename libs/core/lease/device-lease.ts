/**
 * device-lease — the shared `device` adapter behind the video and audio
 * device lease managers (W3).
 *
 * One device uid is one resource; the holder is the session id. The fenced
 * record lives at `<lease_dir>/<sha256(uid)[0:32]>.json` — the same file the
 * pre-W3 managers wrote — on the lease-backend seam. Pre-W3 records at that
 * path are dual-read for one release: a live legacy record still blocks a
 * second session, an expired or malformed one is replaced.
 *
 * Heartbeats run once per frame/chunk, so a heartbeat always re-checks
 * ownership (cheap read) but renews — lock, write, audit — at most every
 * `ttl / 3`.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeReadFile } from '../secure-io.js';
import {
  isLeaseLive,
  LeaseTermsError,
  leaseExpiresAtIso,
  type LeaseGeneration,
} from './lease-terms.js';
import {
  acquireResourceLeaseSync,
  readResourceLease,
  releaseResourceLeaseSync,
  renewResourceLeaseSync,
  type ResourceLeaseRecord,
  type ResourceLeaseRef,
} from './resource-lease.js';
import type { LeaseBackend } from './lease-backend.js';

/** Public projection kept identical to the pre-W3 device lease record. */
export interface DeviceLeaseRecord {
  lease_id: string;
  device_uid: string;
  pid: number;
  session_id: string;
  acquired_at: string;
  expires_at: string;
  heartbeat_at: string;
}

export interface DeviceLease<R extends DeviceLeaseRecord = DeviceLeaseRecord> {
  readonly record: R;
  heartbeat(): void;
  release(): void;
}

export interface DeviceLeaseManagerOptions {
  lease_dir?: string;
  now?: () => number;
  pid?: number;
  /** Persistence/exclusion backend; defaults to the governed seam (`local-file-lock`). */
  backend?: LeaseBackend;
}

const LEGACY_KEYS = [
  'lease_id',
  'device_uid',
  'pid',
  'session_id',
  'acquired_at',
  'expires_at',
  'heartbeat_at',
] as const;

/** Pre-W3 record (same path): only an exact, well-formed legacy record counts. */
function readLegacyDeviceRecord(leaseKey: string): LeaseGeneration | undefined {
  if (!safeExistsSync(leaseKey) || !safeLstat(leaseKey).isFile()) return undefined;
  const parsed = parseSafeJsonInput(
    String(safeReadFile(leaseKey, { encoding: 'utf8' })),
    'legacy device lease record'
  ) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') return undefined;
  const keys = Object.keys(parsed);
  if (keys.some((key) => !(LEGACY_KEYS as readonly string[]).includes(key))) return undefined;
  if (typeof parsed.session_id !== 'string' || typeof parsed.expires_at !== 'string')
    return undefined;
  if (!Number.isFinite(Date.parse(parsed.expires_at))) return undefined;
  return { holder: parsed.session_id, expires_at: parsed.expires_at };
}

export class DeviceLeaseManager {
  private readonly leaseDir: string;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly backend?: LeaseBackend;
  private readonly label: string;
  private readonly localLeases: Set<string>;

  constructor(
    label: 'video' | 'audio',
    defaultLeaseDir: string,
    localLeases: Set<string>,
    options: DeviceLeaseManagerOptions = {}
  ) {
    this.label = label;
    this.leaseDir = assertSafeRepositoryPath(options.lease_dir ?? defaultLeaseDir, {
      allowMissingLeaf: true,
    });
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.backend = options.backend;
    this.localLeases = localLeases;
  }

  acquire(deviceUid: string, sessionId: string, ttlMs = 30_000): DeviceLease {
    const uid = deviceUid.trim();
    const session = sessionId.trim();
    if (!uid || !session)
      throw new Error(`${this.label} device lease requires device_uid and session_id`);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0)
      throw new Error(`${this.label} device lease ttl must be positive`);
    const leaseKey = this.lockPath(uid);
    if (this.localLeases.has(leaseKey))
      throw new Error(`${this.label} device '${uid}' is already leased in this process`);
    const ref: ResourceLeaseRef = {
      kind: 'device',
      resourceId: `${this.label}:${uid}`,
      leaseKey,
      readLegacy: readLegacyDeviceRecord,
      ...(this.backend ? { backend: this.backend } : {}),
    };
    let fenced: ResourceLeaseRecord;
    try {
      fenced = acquireResourceLeaseSync({
        ...ref,
        holder: session,
        ttlMs,
        nowMs: this.now(),
        attributes: { lease_id: randomUUID(), device_uid: uid, pid: this.pid, session_id: session },
      });
    } catch (error) {
      if (error instanceof LeaseTermsError && error.code === 'LEASE_HELD')
        throw new Error(`${this.label} device '${uid}' is already leased`);
      throw error;
    }
    this.localLeases.add(leaseKey);
    const record = projectDeviceRecord(fenced);
    const renewEveryMs = Math.max(1, Math.floor(ttlMs / 3));
    let released = false;
    const lost = (): Error => {
      released = true;
      this.localLeases.delete(leaseKey);
      return new Error(`${this.label} device lease '${uid}' was lost`);
    };
    return {
      record,
      heartbeat: () => {
        if (released) return;
        const nowMs = this.now();
        const current = readResourceLease(ref);
        if (!current || current.fence !== fenced.fence || current.owner_id !== fenced.owner_id)
          throw lost();
        const live = isLeaseLive(current, nowMs);
        if (live && nowMs - fenced.renewed_at_ms < renewEveryMs) return;
        try {
          // A stalled stream may outlive its TTL. Nobody took the device (the
          // record is still this generation), so the session takes the next
          // fence instead of reviving the lapsed one.
          fenced = live
            ? renewResourceLeaseSync({ ...ref, lease: fenced, ttlMs, nowMs })
            : acquireResourceLeaseSync({
                ...ref,
                holder: fenced.owner_id,
                ttlMs,
                nowMs,
                ...(fenced.attributes ? { attributes: fenced.attributes } : {}),
              });
        } catch (error) {
          if (error instanceof LeaseTermsError) throw lost();
          throw error;
        }
        const next = projectDeviceRecord(fenced);
        record.heartbeat_at = next.heartbeat_at;
        record.expires_at = next.expires_at;
      },
      release: () => {
        if (released) return;
        released = true;
        this.localLeases.delete(leaseKey);
        releaseResourceLeaseSync({ ...ref, lease: fenced });
      },
    };
  }

  private lockPath(uid: string): string {
    const digest = createHash('sha256').update(uid).digest('hex').slice(0, 32);
    return path.join(this.leaseDir, `${digest}.json`);
  }
}

function projectDeviceRecord(fenced: ResourceLeaseRecord): DeviceLeaseRecord {
  const attributes = fenced.attributes ?? {};
  return {
    lease_id: String(attributes.lease_id ?? ''),
    device_uid: String(attributes.device_uid ?? ''),
    pid: Number(attributes.pid ?? 0),
    session_id: String(attributes.session_id ?? fenced.owner_id),
    acquired_at: new Date(fenced.acquired_at_ms).toISOString(),
    expires_at: leaseExpiresAtIso(fenced),
    heartbeat_at: new Date(fenced.renewed_at_ms).toISOString(),
  };
}
