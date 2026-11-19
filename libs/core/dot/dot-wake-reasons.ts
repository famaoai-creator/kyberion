/**
 * Dot wake failure-reason vocabulary: the tenant-safe failure categories, the
 * process-vs-dot failure split the wake circuit relies on, and the stable
 * reason codes recorded on failed wake-ledger rows. Leaf module (no
 * dot-runtime import); dot-runtime re-exports every name for its callers.
 */
import type { DotCharter } from './dot-charter.js';
import { dotStatePath } from './dot-state-paths.js';

/**
 * Category-only failure reasons. Tenant dots write only these to the shared
 * system-floor wake ledger and heartbeat; the full message goes to the
 * tenant-scoped `wake-errors.jsonl` ({@link dotWakeErrorsPath}).
 */
export const DOT_WAKE_FAILURE_CATEGORY = {
  charter: 'charter unreadable',
  backend: 'backend unavailable',
  wake: 'wake failed',
} as const;
export type DotWakeFailureCategory =
  (typeof DOT_WAKE_FAILURE_CATEGORY)[keyof typeof DOT_WAKE_FAILURE_CATEGORY];

/**
 * Backend / process-level failure (no real backend, no tool-capable
 * candidate, failover chain exhausted): not this dot's fault, so it never
 * counts toward the per-dot wake circuit — a healthy dot resumes as soon as
 * the backend recovers instead of being held for the circuit's backoff.
 */
/**
 * A credential the dot's binding should have served (grant missing/expired, or
 * the bound credential refused at the model call): the tenant's configuration,
 * not the process backend. Counted by the wake circuit, never a reselect.
 */
const DOT_CREDENTIAL_FAILURE =
  /\[DOT_CREDENTIAL_GRANT_(?:MISSING|EXPIRED)\]|\[CREDENTIAL_(?:KEY_UNAVAILABLE|PROVIDER_DENIED|ALLOCATION_DENIED|KIND_NOT_ELIGIBLE|ATTESTATION_REQUIRED|TOKEN_EXPIRED|BUDGET_EXCEEDED|CUSTODY_PERSON_MISMATCH|VALUE_CHANGED|RECORD_MISMATCH|RECORD_INVALID)\]/;

export function isDotWakeProcessFailure(reason: string | undefined): boolean {
  if (!reason) return false;
  if (DOT_CREDENTIAL_FAILURE.test(reason)) return false;
  if (reason === DOT_WAKE_FAILURE_CATEGORY.backend) return true;
  return /no real reasoning backend|lacks generateWithTools|failed across \d+ candidate|has no tool-capable backend/.test(
    reason
  );
}

export type DotWakeReasonCode =
  | 'backend_unavailable'
  | 'no_tool_backend'
  | 'provider_failover_exhausted'
  | 'wall_clock_exceeded'
  | 'charter'
  | 'credential_grant'
  | 'standing_binding'
  /** Skipped, not failed: the wall clock ran out while the host was asleep. */
  | 'host_suspended'
  | 'wake';

/** Map a failed wake's reason text (full text or tenant category) to a stable code. */
export function classifyDotWakeReason(reason: string | undefined): DotWakeReasonCode {
  const text = String(reason ?? '');
  // Standing-binding refusals (dot-standing-binding.ts): fix the grant or claim, not the dot.
  if (DOT_CREDENTIAL_FAILURE.test(text)) return 'credential_grant';
  if (/\[DOT_STANDING_[A-Z_]+\]/.test(text)) return 'standing_binding';
  if (/wall_clock budget/.test(text)) return 'wall_clock_exceeded';
  if (/lacks generateWithTools|has no tool-capable backend|failed across 0 candidate/.test(text))
    return 'no_tool_backend';
  if (/failed across \d+ candidate/.test(text)) return 'provider_failover_exhausted';
  if (text === DOT_WAKE_FAILURE_CATEGORY.backend || /no real reasoning backend/.test(text))
    return 'backend_unavailable';
  if (text === DOT_WAKE_FAILURE_CATEGORY.charter) return 'charter';
  return 'wake';
}

/** Tenant-scoped full-text wake error log for a dot. */
export function dotWakeErrorsPath(charter: DotCharter): string {
  return dotStatePath(charter, 'wake-errors.jsonl');
}

/** Digits and hex runs stripped, so "same failure, different id/mtime" is one reason. */
export function normalizeDotWakeReason(reason: string | undefined): string {
  return String(reason ?? '')
    .replace(/\b[0-9a-f]{6,}\b/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}
