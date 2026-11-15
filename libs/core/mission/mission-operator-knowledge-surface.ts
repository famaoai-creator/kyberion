/**
 * Operator-facing promoted-knowledge surface (D8 / MEMORY_LOOP_CLOSURE).
 *
 * KP-05 delivery telemetry only observed the dispatched-worker path:
 * `recordKnowledgeDelivery` runs inside worker context packs, background
 * review and ADF repair, so direct_cli missions delivered no promoted
 * knowledge and `computeMemoryLoopHealth` measured the loop as permanently
 * open (promoted > 0, retrieved = 0). This surface closes the gap for the
 * operator path: at mission start/kickoff/resume it retrieves the top
 * promoted records for the mission goal, prints them for the operator and
 * records the delivery through the same `recordKnowledgeDelivery` writer,
 * so the loop metric counts direct_cli deliveries too.
 *
 * Fail-open: a retrieval or delivery error must never block the lifecycle
 * verb — it only means no section gets printed.
 */
import { logger } from '../core.js';
import { findRelevantPromotedKnowledge } from '../knowledge/promoted-knowledge-retrieval.js';
import { recordKnowledgeDelivery } from '../knowledge/knowledge-feedback-loop.js';
import { createKnowledgeDeliverySnapshot } from '../knowledge/knowledge-delivery-snapshot.js';
import { loadState } from './mission-state.js';
import type { MemoryScopeEnvelope } from '../knowledge/memory-scope.js';

export const OPERATOR_PROMOTED_RETRIEVAL_LIMIT = 3;

/**
 * Lifecycle-verb seam: load the mission, surface the promoted records for its
 * goal and print them. No-ops unless the mission is active. Fail-open — a
 * state-load or retrieval problem must never block start/kickoff/resume.
 */
export async function printPromotedKnowledgeForActiveMission(
  missionId: string,
  emit: (line: string) => void = (line) => logger.info(line)
): Promise<void> {
  try {
    const state = loadState(missionId);
    if (state?.status !== 'active') return;
    for (const line of await surfacePromotedKnowledgeForOperator({
      missionId,
      topic: state.intent?.goal_summary || state.intent?.source_text || '',
      scope: {
        tier: state.tier,
        ...(state.tenant_slug ? { tenant_slug: state.tenant_slug } : {}),
        ...(state.organization_id ? { organization_id: state.organization_id } : {}),
        mission_id: missionId,
      },
    })) {
      emit(`   ${line}`);
    }
  } catch {
    // Fail-open — see module doc.
  }
}

export async function surfacePromotedKnowledgeForOperator(input: {
  missionId: string;
  /** Retrieval topic — the mission goal summary or source text. */
  topic: string;
  scope?: MemoryScopeEnvelope;
  limit?: number;
  /** Test seam: repo root containing a fixture `knowledge/`. */
  rootDir?: string;
}): Promise<string[]> {
  const topic = input.topic.trim();
  if (!topic) return [];
  try {
    const limit = Math.max(1, Math.floor(input.limit ?? OPERATOR_PROMOTED_RETRIEVAL_LIMIT));
    const entries = await findRelevantPromotedKnowledge({
      topic,
      limit,
      minScore: 0.08,
      scope: input.scope,
      ...(input.rootDir ? { rootDir: input.rootDir } : {}),
    });
    if (entries.length === 0) return [];
    recordKnowledgeDelivery({
      missionId: input.missionId,
      recipientKind: 'operator_cli',
      scope: input.scope,
      refs: entries.map((entry) => ({
        path: entry.path,
        ...(typeof entry.score === 'number' ? { score: entry.score } : {}),
        ...(entry.title ? { title: entry.title } : {}),
        snapshot: createKnowledgeDeliverySnapshot({
          text: `- ${entry.title} (${entry.path})\n  ${entry.excerpt.trim().replace(/\s+/g, ' ').slice(0, 200)}`,
          form: 'context_string',
          ...(entry.source_sha256 ? { source_sha256: entry.source_sha256 } : {}),
        }),
      })),
    });
    const lines = [`Promoted knowledge relevant to this mission (${entries.length}):`];
    for (const entry of entries) {
      lines.push(`- ${entry.title} (${entry.path})`);
      lines.push(`  ${entry.excerpt.trim().replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    return lines;
  } catch (err) {
    logger.warn(
      `[MISSION] promoted-knowledge surface failed for ${input.missionId}: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}
