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
 * recorded in attempts[]. Wiring into the MO-01 code_change template and
 * MO-02 gates consumes this module next.
 */

import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';

export type AiDlcPhase = 'alignment' | 'execution' | 'test' | 'self_review' | 'complete';

export interface AiDlcAttempt {
  phase: AiDlcPhase;
  at: string;
  outcome: 'passed' | 'failed';
  note?: string;
}

export interface AiDlcPhaseResult {
  summary: string;
  artifact_refs: string[];
}

export interface AiDlcFailureContext {
  failed_phase: AiDlcPhase;
  what_failed: string;
  attempted: string[];
  open_questions: string[];
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
  attempts: AiDlcAttempt[];
  updated_at: string;
}

const PHASE_ORDER: AiDlcPhase[] = ['alignment', 'execution', 'test', 'self_review', 'complete'];

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
    updated_at: options.now ?? new Date().toISOString(),
  };
}

function nextPhase(current: AiDlcPhase): AiDlcPhase | null {
  const index = PHASE_ORDER.indexOf(current);
  return index >= 0 && index < PHASE_ORDER.length - 1 ? PHASE_ORDER[index + 1] : null;
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
  now: string = new Date().toISOString()
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
      next,
      {
        failed_phase: input.phase,
        what_failed: input.result.summary,
        attempted: state.attempts.map((attempt) => `${attempt.phase}:${attempt.outcome}`),
        open_questions: [],
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
  now: string = new Date().toISOString()
): AiDlcPhaseState {
  return {
    ...state,
    phase: 'alignment',
    failure_context: failure,
    attempts: [...state.attempts, { phase: failure.failed_phase, at: now, outcome: 'failed' }],
    updated_at: now,
  };
}

// ─── Persistence (mission evidence) ──────────────────────────────────────────

export function aiDlcPhaseStatePath(missionId: string, baseDir?: string): string {
  // baseDir substitutes the missions root (tests); the per-mission evidence
  // namespace is preserved either way.
  const root = baseDir
    ? path.join(baseDir, missionId, 'evidence')
    : pathResolver.active(`missions/${missionId}/evidence`);
  return path.join(root, 'aidlc-phase-state.json');
}

export function saveAiDlcPhaseState(state: AiDlcPhaseState, baseDir?: string): string {
  const filePath = aiDlcPhaseStatePath(state.mission_id, baseDir);
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, `${JSON.stringify(state, null, 2)}\n`);
  return filePath;
}

export function loadAiDlcPhaseState(missionId: string, baseDir?: string): AiDlcPhaseState | null {
  const filePath = aiDlcPhaseStatePath(missionId, baseDir);
  if (!safeExistsSync(filePath)) return null;
  try {
    return JSON.parse(String(safeReadFile(filePath, { encoding: 'utf8' }))) as AiDlcPhaseState;
  } catch {
    return null;
  }
}
