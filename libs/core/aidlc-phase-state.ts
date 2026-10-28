/**
 * aidlc-phase-state.ts — HO-02 Task 1: the state object that flows between
 * AI-DLC phases (Alignment → Execution → Test → Self-Review), with a
 * circuit breaker that routes failures back to Alignment carrying an
 * explicit failure_context instead of losing it.
 *
 * Per the plan's risk note this is the minimal-phase proof: downstream
 * phases receive the upstream structured result (no diff re-derivation),
 * payloads stay summary+refs shaped (MO-04 budget principle — full outputs
 * live in the artifact store and travel as refs), and every transition is
 * recorded in attempts[]. Mission gate receipts project into this shape;
 * gate/task-board authority remains with the existing mission controller.
 */

import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import { missionEvidenceDir, pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from './secure-io.js';
import { getDefaultWorkerEventStream } from './workforce/worker-event-stream.js';

export type AiDlcPhase = 'alignment' | 'execution' | 'test' | 'self_review' | 'complete';

export interface AiDlcAttempt {
  phase: AiDlcPhase;
  at: string;
  outcome: 'passed' | 'failed';
  note?: string;
  /** Durable gate receipt identity; replay never invents a second attempt. */
  receipt_id?: string;
  gate_id?: string;
  artifact_refs?: string[];
}

export interface AiDlcPhaseResult {
  summary: string;
  artifact_refs: string[];
}

export interface AiDlcFailureContext {
  gate_id?: string;
  failed_phase: AiDlcPhase;
  what_failed: string;
  attempted: string[];
  open_questions: string[];
  artifact_refs?: string[];
}

export interface AiDlcPhaseState {
  version: '1.0.0';
  mission_id: string;
  task_board_ref?: string;
  phase: AiDlcPhase;
  execution_result?: AiDlcPhaseResult;
  test_output?: AiDlcPhaseResult & { passed: boolean };
  review_findings?: AiDlcPhaseResult & { approved: boolean };
  failure_context?: AiDlcFailureContext;
  resume_count?: number;
  last_resumed_at?: string;
  attempts: AiDlcAttempt[];
  updated_at: string;
}

const PHASE_ORDER: AiDlcPhase[] = ['alignment', 'execution', 'test', 'self_review', 'complete'];

const AIDLC_PHASE_STATE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/aidlc-phase-state.schema.json'
);

function aiDlcPhaseStateCatalog(filePath: string) {
  return defineCatalog<AiDlcPhaseState>({
    id: 'aidlc-phase-state',
    path: filePath,
    schema: AIDLC_PHASE_STATE_SCHEMA_PATH,
  });
}

export function createAiDlcPhaseState(
  missionId: string,
  options: { taskBoardRef?: string; now?: string } = {}
): AiDlcPhaseState {
  return {
    version: '1.0.0',
    mission_id: missionId,
    ...(options.taskBoardRef ? { task_board_ref: options.taskBoardRef } : {}),
    phase: 'alignment',
    attempts: [],
    updated_at: options.now ?? nowIso(),
  };
}

function nextPhase(current: AiDlcPhase): AiDlcPhase | null {
  const index = PHASE_ORDER.indexOf(current);
  return index >= 0 && index < PHASE_ORDER.length - 1 ? PHASE_ORDER[index + 1] : null;
}

/** Phases whose transition is guarded by a pass/approve gate. */
const GATED_PHASES = new Set(['test', 'self_review']);

function emitAiDlcPhaseEvents(
  state: AiDlcPhaseState,
  input: { phase: AiDlcPhase; result: AiDlcPhaseResult },
  failedGate: boolean,
  now: string
): void {
  try {
    const stream = getDefaultWorkerEventStream();
    const source = { mission_id: state.mission_id };
    stream.emit('phase_end', { phase: state.phase, at: now }, source);
    if (GATED_PHASES.has(input.phase)) {
      stream.emit(
        'gate_evaluated',
        {
          phase: input.phase,
          outcome: failedGate ? 'failed' : 'passed',
          summary: input.result.summary,
          at: now,
        },
        source
      );
    }
    // A failed gate keeps the mission in its current phase and trips the
    // breaker back to alignment, so the phase that begins is not `input.phase`.
    stream.emit(
      'phase_begin',
      { phase: failedGate ? 'alignment' : input.phase, at: now, after_failed_gate: failedGate },
      source
    );
  } catch {
    // Observability must never turn a valid transition into a failed one.
  }
}

/**
 * Advance to the next phase, attaching that phase's structured result to the
 * state so the successor receives it as data (not by re-deriving diffs).
 * Transitions are strictly ordered; anything else must go through the
 * circuit breaker.
 */
export function advanceAiDlcPhase(
  state: AiDlcPhaseState,
  input:
    | { phase: 'execution'; result: AiDlcPhaseResult }
    | { phase: 'test'; result: AiDlcPhaseResult & { passed: boolean } }
    | { phase: 'self_review'; result: AiDlcPhaseResult & { approved: boolean } },
  now: string = nowIso()
): AiDlcPhaseState {
  const expected = nextPhase(state.phase);
  if (input.phase !== expected) {
    throw new Error(
      `[aidlc-phase-state] invalid transition ${state.phase} → ${input.phase} (expected ${expected ?? 'none'})`
    );
  }
  const failedGate =
    (input.phase === 'test' && !input.result.passed) ||
    (input.phase === 'self_review' && !input.result.approved);

  // EV-07: `phase_begin` / `phase_end` / `gate_evaluated` were declared in
  // WORKER_EVENT_TYPES but never emitted, so a consumer could not tell "no phase
  // transition happened" from "phase events are not implemented". This is the
  // one place that decides a transition — including the failed-gate case, which
  // a persistence-time hook could not distinguish, since the phase does not
  // change. Emission is a deliberate observability side effect on a fail-open
  // stream: a listener failure never propagates (see worker-event-stream).
  emitAiDlcPhaseEvents(state, input, failedGate, now);

  const next: AiDlcPhaseState = {
    ...state,
    phase: failedGate ? state.phase : input.phase === 'self_review' ? 'complete' : input.phase,
    attempts: [
      ...state.attempts,
      { phase: input.phase, at: now, outcome: failedGate ? 'failed' : 'passed' },
    ],
    updated_at: now,
  };
  if (input.phase === 'execution') next.execution_result = input.result;
  if (input.phase === 'test') next.test_output = input.result;
  if (input.phase === 'self_review') next.review_findings = input.result;

  if (failedGate) {
    return tripAiDlcCircuitBreaker(
      { ...next, attempts: state.attempts },
      {
        failed_phase: input.phase,
        what_failed: input.result.summary,
        attempted: state.attempts.map((attempt) => `${attempt.phase}:${attempt.outcome}`),
        open_questions: [],
        artifact_refs: input.result.artifact_refs,
      },
      now
    );
  }
  return next;
}

/**
 * Circuit breaker: route back to Alignment with an explicit failure_context
 * (what failed, what was attempted, what remains open) so the re-planning
 * phase starts informed instead of from scratch.
 */
export function tripAiDlcCircuitBreaker(
  state: AiDlcPhaseState,
  failure: AiDlcFailureContext,
  now: string = nowIso()
): AiDlcPhaseState {
  return {
    ...state,
    phase: 'alignment',
    failure_context: failure,
    attempts: [...state.attempts, { phase: failure.failed_phase, at: now, outcome: 'failed' }],
    updated_at: now,
  };
}

export interface AiDlcGateReceipt {
  receipt_id: string;
  sequence?: number;
  gate_id?: string;
  phase: Exclude<AiDlcPhase, 'complete'>;
  verdict: 'pass' | 'fail';
  checked_at: string;
  summary: string;
  artifact_refs: string[];
  open_questions?: string[];
}

/**
 * Read-model projection of canonical mission gate receipts. Unlike advance,
 * this does not decide whether work may proceed or fabricate missing phases.
 * The mission gate and task board remain the authority for that decision.
 */
export function projectAiDlcGateReceipt(
  state: AiDlcPhaseState,
  receipt: AiDlcGateReceipt
): AiDlcPhaseState {
  if (state.attempts.some((attempt) => attempt.receipt_id === receipt.receipt_id)) return state;
  const result = { summary: receipt.summary, artifact_refs: receipt.artifact_refs };
  const next: AiDlcPhaseState = {
    ...state,
    phase:
      receipt.verdict === 'fail'
        ? 'alignment'
        : receipt.phase === 'self_review'
          ? 'complete'
          : receipt.phase,
    attempts: [
      ...state.attempts,
      {
        phase: receipt.phase,
        at: receipt.checked_at,
        outcome: receipt.verdict === 'pass' ? 'passed' : 'failed',
        note: receipt.summary,
        receipt_id: receipt.receipt_id,
        ...(receipt.gate_id ? { gate_id: receipt.gate_id } : {}),
        artifact_refs: receipt.artifact_refs,
      },
    ],
    updated_at: receipt.checked_at,
  };
  if (receipt.phase === 'execution') next.execution_result = result;
  if (receipt.phase === 'test')
    next.test_output = { ...result, passed: receipt.verdict === 'pass' };
  if (receipt.phase === 'self_review')
    next.review_findings = { ...result, approved: receipt.verdict === 'pass' };
  if (receipt.verdict === 'fail') {
    next.failure_context = {
      ...(receipt.gate_id ? { gate_id: receipt.gate_id } : {}),
      failed_phase: receipt.phase,
      what_failed: receipt.summary,
      attempted: next.attempts.map((attempt) => `${attempt.phase}:${attempt.outcome}`),
      open_questions: receipt.open_questions ?? [],
      artifact_refs: receipt.artifact_refs,
    };
  }
  // A fresh alignment receipt is the explicit re-plan boundary. Passing an
  // unrelated later gate never silently erases the failure's provenance.
  if (receipt.phase === 'alignment' && receipt.verdict === 'pass') delete next.failure_context;
  if (
    receipt.verdict === 'pass' &&
    receipt.gate_id &&
    receipt.gate_id === state.failure_context?.gate_id
  )
    delete next.failure_context;
  // More than one phase gate may fail in a completion sweep. Passing one
  // must not hide an independently unresolved failure from another gate.
  const pending = new Map<string, AiDlcAttempt>();
  for (const attempt of next.attempts) {
    if (attempt.phase === 'alignment' && attempt.outcome === 'passed') pending.clear();
    else if (attempt.gate_id) {
      if (attempt.outcome === 'failed') pending.set(attempt.gate_id, attempt);
      else pending.delete(attempt.gate_id);
    }
  }
  const unresolved = [...pending.values()].at(-1);
  if (unresolved && unresolved.gate_id !== next.failure_context?.gate_id) {
    next.failure_context = {
      gate_id: unresolved.gate_id,
      failed_phase: unresolved.phase,
      what_failed: unresolved.note ?? 'Mission gate failed',
      attempted: next.attempts.map((attempt) => `${attempt.phase}:${attempt.outcome}`),
      open_questions: [],
      artifact_refs: unresolved.artifact_refs ?? [],
    };
  }
  if (next.failure_context) next.phase = 'alignment';
  return next;
}

// ─── Persistence (mission evidence) ──────────────────────────────────────────

export function aiDlcPhaseStatePath(missionId: string, baseDir?: string): string {
  pathResolver.assertMissionIdArgument(missionId);
  // baseDir substitutes the missions root (tests); the per-mission evidence
  // namespace is preserved either way.
  const root = baseDir ? path.join(baseDir, missionId, 'evidence') : missionEvidenceDir(missionId);
  if (!root) throw new Error(`[aidlc-phase-state] existing mission required: ${missionId}`);
  return assertSafeRepositoryPath(path.join(root, 'aidlc-phase-state.json'), {
    allowMissingLeaf: true,
  });
}

export function saveAiDlcPhaseState(state: AiDlcPhaseState, baseDir?: string): string {
  const filePath = aiDlcPhaseStatePath(state.mission_id, baseDir);
  const validated = aiDlcPhaseStateCatalog(filePath).validate(state, filePath);
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, `${JSON.stringify(validated, null, 2)}\n`);
  return filePath;
}

/** Load one persisted AI-DLC state through schema and mission scope validation. */
export function loadAiDlcPhaseStateAtPath(filePath: string, missionId: string): AiDlcPhaseState {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[aidlc-phase-state] state must be a regular file: ${filePath}`);
  }
  const state = aiDlcPhaseStateCatalog(safeFilePath).load();
  const expectedMissionId = missionId.trim().toUpperCase();
  if (state.mission_id.trim().toUpperCase() !== expectedMissionId) {
    throw new Error(
      `[AIDLC_PHASE_STATE_SCOPE_MISMATCH] state belongs to ${state.mission_id}, expected ${expectedMissionId}`
    );
  }
  return state;
}

export function loadAiDlcPhaseState(missionId: string, baseDir?: string): AiDlcPhaseState | null {
  const filePath = aiDlcPhaseStatePath(missionId, baseDir);
  if (!safeExistsSync(filePath)) return null;
  try {
    return loadAiDlcPhaseStateAtPath(filePath, missionId);
  } catch {
    return null;
  }
}

/**
 * Resume a persisted AI-DLC run without discarding the failure context that
 * Alignment needs to continue the work. The operation is intentionally
 * idempotent in its data shape and records a small audit-friendly counter
 * instead of fabricating a new phase result.
 */
export function resumeAiDlcPhaseState(
  missionId: string,
  options: { baseDir?: string; now?: string } = {}
): AiDlcPhaseState {
  const state = loadAiDlcPhaseState(missionId, options.baseDir);
  if (!state) throw new Error(`[aidlc-phase-state] no persisted state for ${missionId}`);
  if (state.phase === 'complete') {
    throw new Error(`[aidlc-phase-state] cannot resume completed mission ${missionId}`);
  }
  const resumedAt = options.now ?? nowIso();
  const resumed: AiDlcPhaseState = {
    ...state,
    resume_count: (state.resume_count || 0) + 1,
    last_resumed_at: resumedAt,
    updated_at: resumedAt,
  };
  saveAiDlcPhaseState(resumed, options.baseDir);
  return resumed;
}
