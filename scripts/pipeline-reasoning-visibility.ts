import { findMissionPath, type ReasoningPromptVisibilityContext } from '@agent/core';

/** DH-06: bind pipeline model visibility to the mission-local durable ledger. */
export function buildPipelinePromptVisibilityContext(
  ctx: Record<string, unknown>
): ReasoningPromptVisibilityContext | undefined {
  const missionId = String(ctx.mission_id || process.env.MISSION_ID || '').trim();
  if (!missionId) return undefined;
  const missionPath = findMissionPath(missionId);
  if (!missionPath) return undefined;
  const rawKnowledgeRefs = ctx.__knowledge_refs;
  const knowledgeRefs = Array.isArray(rawKnowledgeRefs)
    ? rawKnowledgeRefs.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    missionPath,
    missionId,
    ...(typeof ctx.task_id === 'string' ? { taskId: ctx.task_id } : {}),
    ...(typeof ctx.context_pack_id === 'string' ? { contextPackId: ctx.context_pack_id } : {}),
    knowledgeRefs,
    source: 'run_pipeline',
    form: 'pipeline_reasoning',
  };
}
