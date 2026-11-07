/**
 * lease-backend seam — the pluggable mutual-exclusion + fenced-lease-record
 * extension point (Step-2 of the distributed runtime architecture).
 *
 * Durable single-writer resources need two guarantees that today only a
 * local filesystem provides: an inter-process mutex while a lease is
 * inspected/acquired/released, and a fenced lease record that outlives the
 * holder. Distributed runtimes (multi-container workers) need the same
 * guarantees over Redis/DynamoDB/KV instead.
 *
 * Providers register by id (`local-file-lock` builtin, `memory` for hermetic
 * tests, `kv-lock-stub` for a Redis/KV contract double, real kv-lock /
 * ddb-conditional-put adapters later); selection order is governed data
 * (`seam-provider-selection/lease-backend.json` `default_chains`), never a
 * hard-coded preference list.
 *
 * Distributed backends may refuse `withLockSync` (no cross-runtime blocking
 * mutex). Callers that need multi-node exclusion must use `withLock`.
 *
 * The contract deliberately separates the mutex from the record: callers
 * (writer-lease and friends) own acquire/renew/release policy, error codes,
 * events and metrics; the backend owns exclusion and record persistence.
 * `read`/`write` MUST run inside `withLock`/`withLockSync` for the same
 * namespace — a backend that cannot hold exclusion across a caller-supplied
 * callback would break the single-writer invariant, so it is part of the
 * contract, not an implementation detail.
 */

import { createProviderRegistry } from '../provider/provider-registry.js';
import type { SeamProviderMetadata } from '../seam.js';
import { resolveSeamDefaultOrder } from '../seam-provider-selection.js';

export const LEASE_BACKEND_SEAM = 'lease-backend';
/** Builtin default provider id; also the governed `default_provider`. */
export const LOCAL_LEASE_BACKEND_ID = 'local-file-lock';

/** Minimal fenced lease record: TTL + fencing token are contractual. */
export interface FencedLeaseRecord {
  resource_id: string;
  owner_id: string;
  /** Monotonic fencing token; strictly increasing per resource. */
  fence: number;
  /** Epoch ms after which the record no longer counts as held. */
  expires_at_ms: number;
}

export interface LeaseBackend {
  readonly id: string;
  /**
   * Run `fn` under the namespace's mutual-exclusion lock. Acquisition, the
   * protected read/write sequence and release all happen inside it.
   */
  withLock<T>(namespace: string, fn: () => Promise<T>): Promise<T>;
  /** Synchronous counterpart for callers that cannot await. */
  withLockSync<T>(namespace: string, fn: () => T): T;
  /** Current lease record for the key, or undefined when absent/corrupt. */
  read(leaseKey: string): FencedLeaseRecord | undefined;
  /** Persist the lease record atomically. Called under the caller-held lock. */
  write(leaseKey: string, record: FencedLeaseRecord): void;
  /**
   * Where caller observability (durable metrics) should be written for this
   * lease, or null when the backend has no durable side-channel (e.g. memory).
   */
  metricsPath?(leaseKey: string): string | null;
}

const leaseBackendRegistry = createProviderRegistry<LeaseBackend>({
  seam: LEASE_BACKEND_SEAM,
  owner: 'libs/core/lease/lease-backend.ts',
  source: 'lease-backend-extension',
  missingIdError: 'LeaseBackend must have a non-empty id',
});

export function registerLeaseBackend(
  backend: LeaseBackend,
  metadata?: SeamProviderMetadata
): () => void {
  return leaseBackendRegistry.register(backend, metadata);
}

export function listLeaseBackends(): LeaseBackend[] {
  return leaseBackendRegistry.list();
}

export function getLeaseBackend(id: string): LeaseBackend | undefined {
  return leaseBackendRegistry.get(id);
}

export function resetLeaseBackends(): void {
  leaseBackendRegistry.reset();
}

/**
 * Resolve the backend for a caller. An explicit selector always wins; without
 * one the saved seam default (`KYBERION_SEAM_DEFAULTS` / scope layers) then the
 * governed `default_chains.default` ordering picks the first
 * registered provider, falling back to `local-file-lock` then to whatever is
 * registered. Throws when nothing is registered — local-file-lock is
 * installed by importing `local-lease-backend.ts`, which writer-lease does.
 */
export function resolveLeaseBackend(selector?: string): LeaseBackend {
  const explicit = selector?.trim();
  if (explicit) {
    const backend = leaseBackendRegistry.get(explicit);
    if (!backend) {
      throw new Error(
        `[LEASE_BACKEND] unknown backend '${explicit}' — registered: ${
          leaseBackendRegistry
            .list()
            .map((b) => b.id)
            .join(', ') || '(none)'
        }`
      );
    }
    return backend;
  }
  const chain = resolveSeamDefaultOrder(LEASE_BACKEND_SEAM, { builtin: [LOCAL_LEASE_BACKEND_ID] });
  for (const id of chain) {
    const backend = leaseBackendRegistry.get(id);
    if (backend) return backend;
  }
  const first = leaseBackendRegistry.list()[0];
  if (first) return first;
  throw new Error(
    '[LEASE_BACKEND] no backend registered — import @agent/core/lease/local-lease-backend (or register one)'
  );
}
