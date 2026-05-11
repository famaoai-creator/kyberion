import {
  emitIntentSnapshot,
  evaluateIntentDriftGate,
  getIntentExtractor,
  logger,
  mapStageToLoopPhase,
} from '@agent/core';

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
  const firstLine = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)[0] ?? '';
  if (!firstLine) return '';
  return firstLine.length <= 200 ? firstLine : `${firstLine.slice(0, 197)}...`;
}

export async function emitMissionLifecycleIntentSnapshot(input: {
  missionId: string;
  stage: string;
  text?: string;
  source?: 'user_prompt' | 'mission_state' | 'gate_evaluation' | 'worker_transition' | 'manual';
}): Promise<void> {
  if (!input.missionId) return;
  const source = input.source || 'mission_state';
  try {
    const trimmed = String(input.text || '').trim();
    if (trimmed) {
      const intent =
        source === 'user_prompt'
          ? await getIntentExtractor()
              .extract({ text: trimmed })
              .catch(() => ({
                goal: summarizeIntentText(trimmed) || fallbackGoalForStage(input.missionId, input.stage),
              }))
          : {
              goal: summarizeIntentText(trimmed) || fallbackGoalForStage(input.missionId, input.stage),
            };
      emitIntentSnapshot({
        missionId: input.missionId,
        stage: input.stage,
        source,
        intent,
      });
      return;
    }
    emitIntentSnapshot({
      missionId: input.missionId,
      stage: input.stage,
      source,
      intent: { goal: fallbackGoalForStage(input.missionId, input.stage) },
    });
  } catch (err: any) {
    logger.warn(
      `[mission-intent-delta] snapshot emission skipped for ${input.missionId}/${input.stage}: ${err?.message || err}`,
    );
  }
}

export function evaluateMissionIntentDrift(missionId: string): MissionIntentDriftSummary | null {
  try {
    const gate = evaluateIntentDriftGate(missionId);
    return {
      checked_at: new Date().toISOString(),
      passed: gate.passed,
      verdict: gate.verdict,
      drift_score: gate.driftScore,
      message: gate.message,
    };
  } catch (err: any) {
    logger.warn(`[mission-intent-delta] drift gate evaluation skipped for ${missionId}: ${err?.message || err}`);
    return null;
  }
}
