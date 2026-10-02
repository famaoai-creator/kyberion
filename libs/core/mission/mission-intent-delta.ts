import {
  emitIntentSnapshot,
  evaluateIntentDriftGate,
  mapStageToLoopPhase,
} from '../intent/intent-snapshot-store.js';
import type { IntentBody } from '../intent/intent-delta.js';
import { getIntentExtractor } from '../intent/intent-extractor.js';
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
 */
async function missionStateIntent(missionId: string): Promise<IntentBody | null> {
  try {
    const { loadState } = await import('./mission-state.js');
    const state = loadState(missionId);
    const goal = String(state?.intent?.goal_summary || '').trim();
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
  } catch {
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
    const canonical = await missionStateIntent(input.missionId);
    const canonicalFill = (intent: IntentBody): IntentBody => {
      // Origin snapshots (creation, scope-approve) carry the contract fields;
      // keep them symmetric so field churn does not manufacture drift.
      return {
        ...intent,
        constraints:
          intent.constraints?.length || !canonical ? intent.constraints : canonical.constraints,
        deliverables:
          intent.deliverables?.length || !canonical ? intent.deliverables : canonical.deliverables,
        stakeholders:
          intent.stakeholders?.length || !canonical ? intent.stakeholders : canonical.stakeholders,
      };
    };
    if (canonical && source === 'mission_state') {
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
        intent: canonicalFill(intent),
        ...(input.traceRef ? { traceRef: input.traceRef } : {}),
      });
      return;
    }
    emitIntentSnapshot({
      missionId: input.missionId,
      stage: input.stage,
      source,
      intent: canonicalFill({ goal: fallbackGoalForStage(input.missionId, input.stage) }),
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
    const gate = evaluateIntentDriftGate(missionId);
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
