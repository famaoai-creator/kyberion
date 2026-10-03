import {
  emitIntentSnapshot,
  evaluateIntentDriftGate,
  mapStageToLoopPhase,
} from '../intent/intent-snapshot-store.js';
import type { IntentBody } from '../intent/intent-delta.js';
import { getIntentExtractor } from '../intent/intent-extractor.js';
import { loadState } from './mission-state.js';
import type { MissionState } from './mission-types.js';
import { logger } from '../core.js';
import { nowIso } from '../foundation/time.js';

export interface MissionIntentDriftSummary {
  checked_at: string;
  passed: boolean;
  verdict: string;
  drift_score: number;
  message: string;
}

function fallbackGoalForStage(missionId: string, stage: string): string {
  return `Mission ${missionId} progressing through ${mapStageToLoopPhase(stage)}`;
}

function summarizeIntentText(text: string): string {
  const firstLine =
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)[0] ?? '';
  if (!firstLine) return '';
  return firstLine.length <= 200 ? firstLine : `${firstLine.slice(0, 197)}...`;
}

/**
 * Canonical intent for a `mission_state` snapshot — the same field shape the
 * origin snapshot records at creation / scope-approve (goal + outcome-contract
 * criteria + expected artifact kinds + project stakeholder). Recording
 * caller-supplied text (a verify note, a progress line) as the goal instead
 * manufactures drift: the text is summarized to ~200 chars while the origin
 * keeps the full goal, and the constraints/deliverables fields drop out
 * entirely — both sides of computeIntentDelta then diverge even when nothing
 * changed.
 *
 * The goal falls back to `intent.source_text` so missions created without an
 * explicit --goal summary (Slack handoffs, vision refs) still carry a stable
 * canonical intent — otherwise every later snapshot records per-stage
 * activity notes as its "goal" and the drift gate blocks on noise.
 *
 * Project a mission state into the canonical IntentBody field shape —
 * `goal_summary || source_text` for goal, outcome-contract criteria/kinds,
 * project stakeholder. Note which state fields count as "intent": goal
 * summary/source text, success criteria, expected artifact kinds, and the
 * project link. `success_condition`, `outcome_ids`, and `excluded` are NOT
 * projected — edits there are invisible to the drift gate.
 *
 * `goalOverride` supplies the goal verbatim (scope-approve writes the new
 * origin before `state.intent` is updated); it falls back to the stored
 * goal when blank.
 */
export function buildCanonicalIntentBody(
  state: MissionState | null | undefined,
  goalOverride?: string
): IntentBody | null {
  const goal = String(
    goalOverride || state?.intent?.goal_summary || state?.intent?.source_text || ''
  ).trim();
  if (!state || !goal) return null;
  return {
    goal,
    constraints: state.outcome_contract?.success_criteria || [],
    deliverables:
      state.outcome_contract?.expected_artifacts?.map((artifact) => artifact.kind) || [],
    stakeholders: state.relationships?.project?.project_id
      ? [state.relationships.project.project_id]
      : [],
  };
}

export function missionCanonicalIntent(missionId: string): IntentBody | null {
  try {
    return buildCanonicalIntentBody(loadState(missionId));
  } catch (err: any) {
    // Fail loud enough to notice: a transient load failure silently falls the
    // drift gate back to comparing against the latest activity line.
    logger.warn(
      `[mission-intent-delta] canonical intent unavailable for ${missionId}: ${err?.message || err}`
    );
    return null;
  }
}

export async function emitMissionLifecycleIntentSnapshot(input: {
  missionId: string;
  stage: string;
  text?: string;
  traceRef?: string;
  source?: 'user_prompt' | 'mission_state' | 'gate_evaluation' | 'worker_transition' | 'manual';
}): Promise<void> {
  if (!input.missionId) return;
  const source = input.source || 'mission_state';
  try {
    const canonical = missionCanonicalIntent(input.missionId);
    // When canonical intent exists, every lifecycle snapshot records it —
    // regardless of source. A snapshot is an intent baseline, not an activity
    // log: letting user_prompt/worker notes write a different goal text means
    // the drift gate later compares the origin against paraphrased activity
    // and manufactures a block. Extraction only runs when there is no
    // canonical intent to anchor to.
    if (canonical) {
      emitIntentSnapshot({
        missionId: input.missionId,
        stage: input.stage,
        source,
        intent: canonical,
        ...(input.traceRef ? { traceRef: input.traceRef } : {}),
      });
      return;
    }
    const trimmed = String(input.text || '').trim();
    if (trimmed) {
      const intent =
        source === 'user_prompt'
          ? await getIntentExtractor()
              .extract({ text: trimmed })
              .catch(() => ({
                goal:
                  summarizeIntentText(trimmed) ||
                  fallbackGoalForStage(input.missionId, input.stage),
              }))
          : {
              goal:
                summarizeIntentText(trimmed) || fallbackGoalForStage(input.missionId, input.stage),
            };
      emitIntentSnapshot({
        missionId: input.missionId,
        stage: input.stage,
        source,
        intent,
        ...(input.traceRef ? { traceRef: input.traceRef } : {}),
      });
      return;
    }
    emitIntentSnapshot({
      missionId: input.missionId,
      stage: input.stage,
      source,
      intent: { goal: fallbackGoalForStage(input.missionId, input.stage) },
      ...(input.traceRef ? { traceRef: input.traceRef } : {}),
    });
  } catch (err: any) {
    logger.warn(
      `[mission-intent-delta] snapshot emission skipped for ${input.missionId}/${input.stage}: ${err?.message || err}`
    );
  }
}

export function evaluateMissionIntentDrift(missionId: string): MissionIntentDriftSummary | null {
  try {
    const gate = evaluateIntentDriftGate(missionId, undefined, missionCanonicalIntent(missionId));
    return {
      checked_at: nowIso(),
      passed: gate.passed,
      verdict: gate.verdict,
      drift_score: gate.driftScore,
      message: gate.message,
    };
  } catch (err: any) {
    logger.warn(
      `[mission-intent-delta] drift gate evaluation skipped for ${missionId}: ${err?.message || err}`
    );
    return null;
  }
}
