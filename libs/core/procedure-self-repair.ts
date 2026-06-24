import { randomUUID } from 'node:crypto';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import {
  type BrowserExtensionAction,
  type BrowserExtensionRecording,
  computeRecordingRiskSummary,
} from './browser-extension-bridge.js';
import type { CompiledBrowserStep } from './browser-recording-compiler.js';
import { type ProcedureDelta } from './procedure-types.js';

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const DELTA_BASE = pathResolver.shared('runtime/procedure-deltas');

function deltaDir(procedureId: string): string {
  return `${DELTA_BASE}/${procedureId}`;
}

function deltaId(createdAt: string): string {
  return `delta-${createdAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * Map a runtime error (and optional failed step context) to a ProcedureDelta
 * repair reason.  The mapping is heuristic — prefer explicit signal words in
 * the error message, fall back to `'ambiguity'` (safest default).
 */
export function classifyFailure(
  error: unknown,
  step?: Pick<CompiledBrowserStep, 'op' | 'summary'>,
): ProcedureDelta['reason'] {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const ctx = (step?.summary ?? '').toLowerCase();
  const combined = `${msg} ${ctx}`;

  if (/mfa|otp|one.time.pass|authenticat|認証コード|二段階|ワンタイム/.test(combined)) return 'mfa';
  if (/popup|modal|dialog|overlay|alert|ポップアップ|ダイアログ|モーダル/.test(combined)) return 'new_popup';
  if (/handoff|navigation|origin.changed|tab.changed|別.*origin|ページ遷移|クロスオリジン/.test(combined)) return 'handoff';
  return 'ambiguity';
}

// ---------------------------------------------------------------------------
// Delta lifecycle
// ---------------------------------------------------------------------------

/**
 * Construct (but do NOT persist) a ProcedureDelta from the failed step and
 * the corrective recording reference.
 *
 * Caller is responsible for:
 *   1. Capturing the corrective recording (new Pattern-A session from anchorStepIndex).
 *   2. Providing `deltaRecordingRef` once the recording is saved.
 *   3. Calling `saveProcedureDelta` to persist.
 *
 * Design: docs/INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md §7 Layer④
 */
export function createProcedureDelta(input: {
  procedureId: string;
  anchorStepIndex: number;
  anchorSnapshotHash?: string;
  deltaRecordingRef: string;
  reason: ProcedureDelta['reason'];
  now?: Date;
}): ProcedureDelta {
  const createdAt = (input.now ?? new Date()).toISOString();
  return {
    schema_version: 'procedure-delta.v1',
    procedure_id: input.procedureId,
    anchor: {
      step_index: input.anchorStepIndex,
      ...(input.anchorSnapshotHash ? { ref_snapshot_hash: input.anchorSnapshotHash } : {}),
    },
    delta_recording_ref: input.deltaRecordingRef,
    reason: input.reason,
    created_at: createdAt,
  };
}

/** Persist a delta and return the file path. */
export function saveProcedureDelta(delta: ProcedureDelta): string {
  const dir = deltaDir(delta.procedure_id);
  safeMkdir(dir, { recursive: true });
  const id = deltaId(delta.created_at);
  const filePath = `${dir}/${id}.json`;
  safeWriteFile(filePath, JSON.stringify(delta, null, 2));
  logger.info(
    `[procedure-self-repair] saved delta "${id}" for procedure "${delta.procedure_id}"`,
  );
  return filePath;
}

/**
 * Map a compiled step index (actionable steps only, sensitive_input_omitted
 * excluded — see browser-recording-compiler) back to an index into the raw
 * recording.actions array.
 */
function actionIndexForCompiledStep(actions: BrowserExtensionAction[], stepIndex: number): number {
  let compiled = -1;
  for (let i = 0; i < actions.length; i++) {
    if (actions[i].op === 'sensitive_input_omitted') continue;
    compiled++;
    if (compiled === stepIndex) return i;
  }
  return actions.length - 1; // fallback: splice at the end
}

/**
 * Close the self-repair loop (review finding AR-H2): splice a corrective
 * recording into the base recording at the delta's anchor and return a MERGED
 * recording draft. The result has `review.status: 'pending'` — it MUST be
 * re-reviewed and re-promoted (via scripts/promote_procedure.ts) before it can
 * execute; this function never auto-activates a procedure.
 *
 * Splice point: immediately AFTER the anchor step (the last good step), so the
 * corrective steps replace whatever failed next.
 */
export function applyProcedureDelta(input: {
  baseRecording: BrowserExtensionRecording;
  deltaRecording: BrowserExtensionRecording;
  delta: ProcedureDelta;
}): BrowserExtensionRecording {
  const { baseRecording, deltaRecording, delta } = input;
  const anchorIdx = actionIndexForCompiledStep(baseRecording.actions, delta.anchor.step_index);
  const head = baseRecording.actions.slice(0, anchorIdx + 1);
  const corrective = deltaRecording.actions;
  const tail = baseRecording.actions.slice(anchorIdx + 1);
  const mergedActions = [...head, ...corrective, ...tail];

  return {
    ...baseRecording,
    recording_id: `${baseRecording.recording_id}+delta-${delta.created_at.replace(/[:.]/g, '-')}`,
    actions: mergedActions,
    risk_summary: computeRecordingRiskSummary(mergedActions),
    // A merged recording is never pre-approved — force human re-review.
    review: {
      status: 'pending',
      decisions: mergedActions.map((a) => ({
        action_id: a.action_id,
        status: a.op === 'sensitive_input_omitted' ? ('rejected' as const) : ('pending' as const),
        ...(a.op === 'sensitive_input_omitted' ? { reason: 'Sensitive input is never replayed.' } : {}),
      })),
    },
  };
}

/** Load a delta by its full file path (as returned by saveProcedureDelta). */
export function loadProcedureDelta(filePath: string): ProcedureDelta | null {
  try {
    const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    return JSON.parse(raw) as ProcedureDelta;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Repair anchor helper
// ---------------------------------------------------------------------------

/**
 * Derive the repair anchor from the step that failed.
 * Returns all fields needed to seed a ProcedureDelta once the corrective
 * recording is available.
 */
export function suggestRepairAnchor(
  failedStep: CompiledBrowserStep,
  error: unknown,
): {
  stepIndex: number;
  snapshotHash?: string;
  reason: ProcedureDelta['reason'];
} {
  return {
    stepIndex: failedStep.step_index,
    snapshotHash: failedStep.snapshot_hash,
    reason: classifyFailure(error, failedStep),
  };
}
