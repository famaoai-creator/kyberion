/**
 * resource-lease — detached (acquire now, release later) leases persisted on
 * the lease-backend seam (W3).
 *
 * writer-lease scopes a lease to one callback. Devices, and any future slot,
 * hold a lease across calls instead: acquire returns a fenced record, renew
 * and release present it back as the token. The record lives under the
 * backend (`local-file-lock` by default) and every read/write happens inside
 * the backend lock for the resource, exactly like writer-lease. Terms come
 * from `lease-terms.ts`; every transition is audited through `lease-audit.ts`.
 *
 * Legacy records (an adapter's pre-W3 file at the same key) are dual-read for
 * one release through `readLegacy`: a live legacy holder still blocks, a
 * lapsed or unreadable one is replaced.
 */

import { recordLeaseAuditEvent } from './lease-audit.js';
import {
  resolveLeaseBackend,
  type FencedLeaseRecord,
  type LeaseBackend,
  type LeaseResourceKind,
} from './lease-backend.js';
import {
  grantLeaseTerms,
  isLeaseLive,
  LeaseTermsError,
  leaseTermsFromRecord,
  releaseLeaseTerms,
  renewLeaseTerms,
  type LeaseGeneration,
  type LeaseTerms,
} from './lease-terms.js';
import './local-lease-backend.js';

export interface ResourceLeaseRef {
  kind: LeaseResourceKind;
  /** Resource name within the kind (device uid, slot id, …). */
  resourceId: string;
  /** Backend record key; `local-file-lock` requires a repo-safe path. */
  leaseKey: string;
  /** Defaults to the governed seam resolution (`local-file-lock`). */
  backend?: LeaseBackend;
  /** Pre-W3 record at the same key, read only when the fenced record is absent or unreadable. */
  readLegacy?: (leaseKey: string) => LeaseGeneration | undefined;
  tenantSlug?: string;
  /** Skip audit for high-frequency renewals the adapter throttles itself. */
  audit?: boolean;
}

export type ResourceLeaseRecord = FencedLeaseRecord & {
  resource_kind: LeaseResourceKind;
  acquired_at_ms: number;
  renewed_at_ms: number;
};

function lockNamespace(ref: ResourceLeaseRef): string {
  return `resource-lease:${ref.kind}:${ref.resourceId}`;
}

function backendOf(ref: ResourceLeaseRef): LeaseBackend {
  return ref.backend ?? resolveLeaseBackend();
}

interface CurrentGeneration {
  record?: FencedLeaseRecord;
  legacy?: LeaseGeneration;
}

function readCurrent(ref: ResourceLeaseRef, backend: LeaseBackend): CurrentGeneration {
  let record: FencedLeaseRecord | undefined;
  let unreadable = false;
  try {
    record = backend.read(ref.leaseKey);
  } catch (error) {
    // Path-safety rejections propagate verbatim (writer-lease parity).
    if (error instanceof Error && error.message.startsWith('[RESOURCE_PATH_')) throw error;
    unreadable = true;
  }
  if (record && record.resource_id === ref.resourceId) return { record };
  if (record) return { record: undefined };
  if (!ref.readLegacy) return {};
  let legacy: LeaseGeneration | undefined;
  try {
    legacy = ref.readLegacy(ref.leaseKey);
  } catch {
    legacy = undefined;
  }
  return unreadable || legacy ? { ...(legacy ? { legacy } : {}) } : {};
}

function termsOf(ref: ResourceLeaseRef, record: FencedLeaseRecord): LeaseTerms {
  return leaseTermsFromRecord({
    kind: ref.kind,
    resourceId: record.resource_id,
    holder: record.owner_id,
    fence: record.fence,
    expires_at: record.expires_at_ms,
    ...(record.acquired_at_ms !== undefined ? { acquired_at: record.acquired_at_ms } : {}),
    ...(record.renewed_at_ms !== undefined ? { renewed_at: record.renewed_at_ms } : {}),
  });
}

function toRecord(
  terms: LeaseTerms,
  attributes?: FencedLeaseRecord['attributes']
): ResourceLeaseRecord {
  return {
    resource_id: terms.resource_id,
    owner_id: terms.holder,
    fence: terms.fence,
    expires_at_ms: terms.expires_at_ms,
    resource_kind: terms.resource_kind,
    acquired_at_ms: terms.acquired_at_ms,
    renewed_at_ms: terms.renewed_at_ms,
    ...(attributes ? { attributes: { ...attributes } } : {}),
  };
}

function audit(
  ref: ResourceLeaseRef,
  event: 'acquire' | 'renew' | 'release' | 'expire',
  terms: LeaseTerms,
  extra: { lease_id?: string; reason?: string } = {}
): void {
  if (ref.audit === false) return;
  recordLeaseAuditEvent({
    event,
    resource_kind: terms.resource_kind,
    resource_id: terms.resource_id,
    holder: terms.holder,
    fence: terms.fence,
    ...(event === 'release' ? {} : { expires_at_ms: terms.expires_at_ms }),
    ...(ref.tenantSlug ? { tenant_slug: ref.tenantSlug } : {}),
    ...extra,
  });
}

function leaseIdOf(record: FencedLeaseRecord): string | undefined {
  const value = record.attributes?.lease_id;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Acquire the next generation for `holder`. Throws `LeaseTermsError`
 * (`LEASE_HELD`) while another generation is live — the same holder included;
 * renew with the record instead.
 */
export function acquireResourceLeaseSync(
  ref: ResourceLeaseRef & {
    holder: string;
    ttlMs: number;
    nowMs?: number;
    attributes?: FencedLeaseRecord['attributes'];
  }
): ResourceLeaseRecord {
  const backend = backendOf(ref);
  const nowMs = ref.nowMs ?? Date.now();
  let displaced: LeaseTerms | undefined;
  const record = backend.withLockSync(lockNamespace(ref), () => {
    const current = readCurrent(ref, backend);
    const previous: LeaseGeneration | undefined = current.record
      ? {
          holder: current.record.owner_id,
          fence: current.record.fence,
          expires_at: current.record.expires_at_ms,
        }
      : current.legacy;
    const terms = grantLeaseTerms({
      kind: ref.kind,
      resourceId: ref.resourceId,
      holder: ref.holder,
      ttlMs: ref.ttlMs,
      nowMs,
      ...(previous ? { previous } : {}),
    });
    if (current.record && current.record.expires_at_ms > 0)
      displaced = termsOf(ref, current.record);
    const next = toRecord(terms, ref.attributes);
    backend.write(ref.leaseKey, next);
    return next;
  });
  if (displaced)
    audit(ref, 'expire', displaced, { reason: 'displaced by a new holder after expiry' });
  audit(ref, 'acquire', termsOf(ref, record), {
    ...(leaseIdOf(record) ? { lease_id: leaseIdOf(record) } : {}),
  });
  return record;
}

/** True while `lease` is still the resource's current, live generation. */
export function isResourceLeaseCurrent(
  ref: ResourceLeaseRef,
  lease: Pick<FencedLeaseRecord, 'owner_id' | 'fence'>,
  nowMs: number = Date.now()
): boolean {
  const current = readCurrent(ref, backendOf(ref)).record;
  return Boolean(
    current &&
    current.owner_id === lease.owner_id &&
    current.fence === lease.fence &&
    isLeaseLive({ expires_at_ms: current.expires_at_ms }, nowMs)
  );
}

/** Read the current record without the lock (diagnostics / ownership probes). */
export function readResourceLease(ref: ResourceLeaseRef): FencedLeaseRecord | undefined {
  return readCurrent(ref, backendOf(ref)).record;
}

/**
 * Renew the holder's live generation (fence unchanged). Throws
 * `LeaseTermsError` `LEASE_NOT_HOLDER` when the record moved to another
 * generation and `LEASE_EXPIRED` once it lapsed.
 */
export function renewResourceLeaseSync(
  ref: ResourceLeaseRef & { lease: FencedLeaseRecord; ttlMs: number; nowMs?: number }
): ResourceLeaseRecord {
  const backend = backendOf(ref);
  const nowMs = ref.nowMs ?? Date.now();
  const record = backend.withLockSync(lockNamespace(ref), () => {
    const current = readCurrent(ref, backend).record;
    if (!current || current.fence !== ref.lease.fence || current.owner_id !== ref.lease.owner_id) {
      throw new LeaseTermsError(
        'LEASE_NOT_HOLDER',
        `${ref.kind}:${ref.resourceId} generation ${ref.lease.fence} of '${ref.lease.owner_id}' is no longer current`,
        current ? { holder: current.owner_id, expires_at_ms: current.expires_at_ms } : {}
      );
    }
    const terms = renewLeaseTerms(termsOf(ref, current), {
      holder: ref.lease.owner_id,
      ttlMs: ref.ttlMs,
      nowMs,
    });
    const next = toRecord(terms, current.attributes);
    backend.write(ref.leaseKey, next);
    return next;
  });
  audit(ref, 'renew', termsOf(ref, record), {
    ...(leaseIdOf(record) ? { lease_id: leaseIdOf(record) } : {}),
  });
  return record;
}

/**
 * Release the holder's generation. Returns false (and writes nothing) when the
 * record already belongs to another generation — a replacement is never
 * clobbered. The fence is kept so stale tokens stay fenced.
 */
export function releaseResourceLeaseSync(
  ref: ResourceLeaseRef & { lease: FencedLeaseRecord }
): boolean {
  const backend = backendOf(ref);
  const released = backend.withLockSync(lockNamespace(ref), () => {
    const current = readCurrent(ref, backend).record;
    if (
      !current ||
      current.fence !== ref.lease.fence ||
      current.owner_id !== ref.lease.owner_id ||
      current.expires_at_ms === 0
    ) {
      return undefined;
    }
    const terms = releaseLeaseTerms(termsOf(ref, current));
    backend.write(ref.leaseKey, toRecord(terms, current.attributes));
    return { terms, lease_id: leaseIdOf(current) };
  });
  if (!released) return false;
  audit(ref, 'release', released.terms, released.lease_id ? { lease_id: released.lease_id } : {});
  return true;
}
