/**
 * Per-dot wake circuit: exponential failure backoff, same-reason streak
 * evaluation, the `credential_grant` hold (lifted early only when the dot's
 * credential inputs change) and the one-alert-per-opening ops alert.
 * dot-runtime re-exports every public name. Imports dot-runtime for types only.
 */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { safeMkdir } from '../secure-io.js';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { sendOpsAlert, type OpsAlertInput } from '../daemon/ops-alert.js';
import { listCredentialAllocations } from '../secret/credential-allocations.js';
import { createLogger } from '../logger.js';
import { isFrontDeskDiagnosticDot, type DotCharter } from './dot-charter.js';
import { dotStatePath } from './dot-state-paths.js';
import {
  DOT_WAKE_LEDGER_PATH,
  dotRuntimePath as runtimePath,
  readDotWakeLedger,
} from './dot-wake-ledger.js';
import {
  classifyDotWakeReason,
  isDotWakeProcessFailure,
  normalizeDotWakeReason,
} from './dot-wake-reasons.js';
import type { DotRuntimeDeps, DueDotTrigger } from './dot-runtime.js';

const logger = createLogger('dot-runtime');

/** A failed wake is retried no sooner than this (per trigger key); doubles per consecutive failure. */
export const DOT_WAKE_RETRY_AFTER_MS = 5 * 60 * 1000;
/** Ceiling of the per-key / per-dot exponential backoff. */
export const DOT_WAKE_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
/** Consecutive same-reason failures that open a dot's wake circuit. */
export const DOT_WAKE_CIRCUIT_THRESHOLD = 5;
/**
 * A `credential_grant` failure opens the circuit at once and holds it this
 * long — unless the dot's credential inputs change first
 * ({@link dotCredentialInputsFingerprint}). Retrying cannot mint a grant.
 */
export const DOT_WAKE_CREDENTIAL_RECHECK_MS = 24 * 60 * 60 * 1000;

/** `min(5min * 2^(n-1), 6h)` for the n-th consecutive failure (n >= 1). */
export function dotWakeBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const exponent = Math.min(consecutiveFailures - 1, 30);
  return Math.min(DOT_WAKE_RETRY_AFTER_MS * 2 ** exponent, DOT_WAKE_MAX_BACKOFF_MS);
}

export interface DotWakeCircuitState {
  /** Trailing failed wakes of this dot sharing one normalized reason. */
  consecutive: number;
  /**
   * The last failure was `credential_grant`: tripped at once, held for
   * {@link DOT_WAKE_CREDENTIAL_RECHECK_MS} or until the credential inputs change.
   */
  credential?: true;
  /** consecutive >= DOT_WAKE_CIRCUIT_THRESHOLD. */
  tripped: boolean;
  /** Tripped and still inside the backoff window — every due trigger is held. */
  open: boolean;
  reason?: string;
  reason_hash?: string;
  last_failed_at?: string;
  streak_started_at?: string;
  /** When a single half-open probe wake is allowed again. */
  reopens_at?: string;
}

/**
 * Per-dot wake circuit: the last {@link DOT_WAKE_CIRCUIT_THRESHOLD} wake
 * attempts (skipped audit markers and backend/process-level failures
 * ignored — see {@link isDotWakeProcessFailure}) all failed with the same
 * normalized reason → hold every trigger until `lastFailedAt + backoff(n)`.
 * This is what stops rotating keys (`watch:<file>@<mtime>`) from defeating
 * the per-key backoff and flooding the ledger with one failure per change.
 * A last failure classified `credential_grant` trips the circuit at once and
 * holds it for {@link DOT_WAKE_CREDENTIAL_RECHECK_MS}; {@link applyDotWakeCircuit}
 * lets one probe through earlier only when the credential inputs changed.
 * `skipped` rows (including `host_suspended`) never count.
 */
export function evaluateDotWakeCircuit(
  charter: DotCharter,
  deps: DotRuntimeDeps = {}
): DotWakeCircuitState {
  const now = (deps.now?.() ?? new Date()).getTime();
  // Skipped audit markers and backend/process-level failures are transparent:
  // they neither extend nor break a dot's own failure streak.
  const rows = readDotWakeLedger(deps).filter(
    (row) =>
      row.dot_id === charter.dot_id &&
      row.outcome !== 'skipped' &&
      !(row.outcome === 'failed' && isDotWakeProcessFailure(row.reason))
  );
  const last = rows.at(-1);
  if (!last || last.outcome !== 'failed') return { consecutive: 0, tripped: false, open: false };
  const reason = normalizeDotWakeReason(last.reason);
  let consecutive = 0;
  let streakStart = last;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.outcome !== 'failed' || normalizeDotWakeReason(row.reason) !== reason) break;
    consecutive += 1;
    streakStart = row;
  }
  const credential =
    (last.reason_code ?? classifyDotWakeReason(last.reason)) === 'credential_grant';
  const tripped = credential || consecutive >= DOT_WAKE_CIRCUIT_THRESHOLD;
  const lastAt = Date.parse(last.fired_at);
  const reopensAt =
    (Number.isFinite(lastAt) ? lastAt : now) +
    (credential
      ? Math.max(DOT_WAKE_CREDENTIAL_RECHECK_MS, dotWakeBackoffMs(consecutive))
      : dotWakeBackoffMs(consecutive));
  return {
    consecutive,
    ...(credential ? { credential: true as const } : {}),
    tripped,
    open: tripped && now < reopensAt,
    reason,
    reason_hash: createHash('sha256').update(reason).digest('hex').slice(0, 12),
    last_failed_at: last.fired_at,
    streak_started_at: streakStart.fired_at,
    ...(tripped ? { reopens_at: new Date(reopensAt).toISOString() } : {}),
  };
}

interface DotWakeCircuitMarker {
  dot_id: string;
  opening_id?: string;
  alerted_at?: string;
  /** Credential inputs as they were when the last `credential_grant` failure was recorded. */
  credential_inputs?: { fingerprint: string; recorded_at: string };
}

function circuitMarkerPath(charter: DotCharter, deps: DotRuntimeDeps): string {
  return runtimePath(deps.rootDir, dotStatePath(charter, 'wake-circuit', `${charter.dot_id}.json`));
}

/**
 * Hash of what a tenant dot's `credential_grant` outcome depends on: the
 * charter's routed backend and scope plus the tenant's `credential.use` grant
 * records (assign / extend / revoke all rewrite one). Undefined for tenantless
 * dots or when the grants cannot be read — the circuit then relies on the
 * {@link DOT_WAKE_CREDENTIAL_RECHECK_MS} recheck alone.
 */
export function dotCredentialInputsFingerprint(
  charter: DotCharter,
  list: (tenant: string) => unknown[] = listCredentialAllocations
): string | undefined {
  const tenant = charter.scope.tenant_slug;
  if (!tenant) return undefined;
  try {
    const grants = list(tenant)
      .map((grant) => JSON.stringify(grant))
      .sort();
    return createHash('sha256')
      .update(
        JSON.stringify({
          backend: charter.runtime.reasoning_backend ?? null,
          scope: charter.scope,
          grants,
        })
      )
      .digest('hex')
      .slice(0, 24);
  } catch (error) {
    logger.debug(
      `credential inputs unreadable for ${charter.dot_id} — ${error instanceof Error ? error.message : String(error)}; the circuit falls back to its recheck window`
    );
    return undefined;
  }
}

function credentialInputsFingerprint(
  charter: DotCharter,
  deps: DotRuntimeDeps
): string | undefined {
  return (deps.credentialInputsFingerprint ?? dotCredentialInputsFingerprint)(charter);
}

/** Remember the inputs a credential failure saw, so only a later change re-opens the dot early. */
export function recordDotCredentialFailureInputs(charter: DotCharter, deps: DotRuntimeDeps): void {
  const markerPath = circuitMarkerPath(charter, deps);
  try {
    const fingerprint = credentialInputsFingerprint(charter, deps);
    const marker = readJsonIfPresent<DotWakeCircuitMarker>(markerPath);
    const { credential_inputs: _previous, ...rest } = marker ?? { dot_id: charter.dot_id };
    safeMkdir(path.dirname(markerPath), { recursive: true });
    writeJson(markerPath, {
      ...rest,
      dot_id: charter.dot_id,
      ...(fingerprint
        ? {
            credential_inputs: {
              fingerprint,
              recorded_at: (deps.now?.() ?? new Date()).toISOString(),
            },
          }
        : {}),
    } satisfies DotWakeCircuitMarker);
  } catch (error) {
    logger.warn(
      `credential-input snapshot failed for ${charter.dot_id} — ${error instanceof Error ? error.message : error} | next: the wake circuit still rechecks after its window | evidence: ${markerPath}`
    );
  }
}

/** True when the credential inputs differ from those the last credential failure saw. */
function dotCredentialInputsChanged(charter: DotCharter, deps: DotRuntimeDeps): boolean {
  try {
    const recorded = readJsonIfPresent<DotWakeCircuitMarker>(circuitMarkerPath(charter, deps))
      ?.credential_inputs?.fingerprint;
    if (!recorded) return false;
    const current = credentialInputsFingerprint(charter, deps);
    return current !== undefined && current !== recorded;
  } catch {
    return false;
  }
}

/** One ops alert per circuit opening, durable across daemon restarts. */
function alertDotWakeCircuitOnce(
  charter: DotCharter,
  circuit: DotWakeCircuitState,
  deps: DotRuntimeDeps
): void {
  const openingId = `${circuit.reason_hash}@${circuit.streak_started_at}`;
  const markerPath = circuitMarkerPath(charter, deps);
  try {
    const marker = readJsonIfPresent<DotWakeCircuitMarker>(markerPath);
    if (marker?.opening_id === openingId) return;
    const alert =
      deps.opsAlert ??
      ((input: OpsAlertInput) =>
        void sendOpsAlert(
          input,
          deps.rootDir
            ? {
                alertLogPath: runtimePath(
                  deps.rootDir,
                  'active/shared/observability/ops-alerts.jsonl'
                ),
              }
            : {}
        ));
    const tenant = charter.scope.tenant_slug;
    alert({
      severity: 'warning',
      title: circuit.credential
        ? `Dot wakes held — credential grant unusable: ${charter.dot_id}`
        : `Dot wake circuit open: ${charter.dot_id}`,
      context: {
        dot_id: charter.dot_id,
        consecutive_failures: circuit.consecutive,
        reopens_at: circuit.reopens_at,
        // All private dots keep failure prose out of the shared alert log.
        ...(charter.scope.tier === 'public' && !charter.scope.tenant_slug
          ? { reason: circuit.reason }
          : {}),
      },
      recommendation: circuit.credential
        ? `Wakes for ${charter.dot_id} failed on its credential binding and are held until the tenant's credential grants change or ${circuit.reopens_at}, whichever comes first. Inspect \`pnpm kyberion reasoning credentials allocations${tenant ? ` --tenant ${tenant}` : ''}\` and the dot's wake-errors.jsonl, then assign or extend the grant (owner approval required); the next sweep after the change probes once.`
        : `Wakes for ${charter.dot_id} are held until ${circuit.reopens_at}. Inspect \`pnpm kyberion dot status ${charter.dot_id}\` and the wake ledger, fix the cause, then the next half-open wake closes the circuit.`,
      dedupe_key: `dot-wake-circuit:${charter.dot_id}:${circuit.reason_hash}`,
      category: 'dot',
    });
    safeMkdir(path.dirname(markerPath), { recursive: true });
    writeJson(markerPath, {
      ...(marker?.credential_inputs ? { credential_inputs: marker.credential_inputs } : {}),
      dot_id: charter.dot_id,
      opening_id: openingId,
      alerted_at: (deps.now?.() ?? new Date()).toISOString(),
    } satisfies DotWakeCircuitMarker);
    logger.warn(
      `wake circuit open for ${charter.dot_id} — ${circuit.consecutive} consecutive failures with one reason | next: fix the cause; one probe wake runs at ${circuit.reopens_at} | evidence: ${DOT_WAKE_LEDGER_PATH}`
    );
  } catch (error) {
    logger.warn(
      `wake circuit alert failed for ${charter.dot_id} — ${error instanceof Error ? error.message : error} | next: wakes stay held regardless | evidence: ${markerPath}`
    );
  }
}

/**
 * Apply the dot's wake circuit to a due list: open → nothing is due (one ops
 * alert per opening); tripped but past the window → only the first trigger
 * runs, marked `circuit: true` (half-open probe); closed → unchanged.
 * Idempotent, so callers that concatenate several due lists re-apply it.
 */
export function applyDotWakeCircuit(
  charter: DotCharter,
  due: DueDotTrigger[],
  deps: DotRuntimeDeps = {}
): DueDotTrigger[] {
  if (isFrontDeskDiagnosticDot(charter)) return [];
  if (due.length === 0) return due;
  const circuit = evaluateDotWakeCircuit(charter, deps);
  if (!circuit.tripped) return due;
  alertDotWakeCircuitOnce(charter, circuit, deps);
  // A credential hold lifts early only when the grant inputs changed since the
  // last refusal; the probe that follows re-records them, so an unrelated edit
  // costs one (model-free) refusal, not a retry per sweep.
  if (circuit.open && !(circuit.credential && dotCredentialInputsChanged(charter, deps))) return [];
  return [{ ...due[0], circuit: true }];
}
