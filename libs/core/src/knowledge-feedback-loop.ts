/**
 * KP-05: knowledge delivery telemetry + task_result knowledge_feedback
 * aggregation — the return half of the loop KP-01 opened up.
 *
 * `provisionTaskKnowledge` (task-knowledge-provisioning.ts) is the single
 * entry point that resolves + renders knowledge for a task; every call that
 * actually delivers `knowledge_hints` reports it here via
 * `recordKnowledgeDelivery`. When a worker's `task_result` later reports
 * `knowledge_feedback` (mission-orchestration-worker.ts,
 * `obtainTaskResultResponse`), `recordKnowledgeUsageFeedback` folds
 * used/not_used counts into the same per-path aggregate and enqueues
 * `missing_topics` as knowledge-gap candidates on the existing
 * memory-promotion queue (KM-03).
 *
 * Conventions deliberately mirrored from `./feedback-loop.ts`: secure-io
 * only, `pathResolver.shared('runtime/feedback-loop/...')`, read-modify-write
 * JSON for the aggregate (not a database), and an env override for hermetic
 * per-test isolation (same shape as `KYBERION_MEMORY_QUEUE_PATH` in
 * `../memory-promotion-queue.ts`).
 *
 * See docs/developer/improvement-plans-2026-07/
 * TASK_KNOWLEDGE_PROVISIONING_PLAN_2026-07-25.ja.md §KP-05.
 */
import * as path from 'node:path';
import { logger } from '../core.js';
import { pathResolver } from '../path-resolver.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '../secure-io.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
} from '../memory-promotion-queue.js';
import type { TaskResultKnowledgeFeedback } from '../channel-surface-types.js';

export interface DeliveredKnowledgeRef {
  path: string;
  score?: number;
  title?: string;
}

export interface KnowledgeDeliveryRecord {
  mission_id: string;
  task_id?: string;
  team_role?: string;
  recipient_kind?: string;
  delivered_at: string;
  refs: DeliveredKnowledgeRef[];
}

export interface KnowledgeUsageAggregateEntry {
  document_path: string;
  delivered_count: number;
  used_count: number;
  not_used_count: number;
  /** Total number of delivery/feedback events that touched this path — mirrors KM-03's occurrences field. */
  occurrences: number;
  last_seen: string;
}

function deliveryLogDir(): string {
  const override = process.env.KYBERION_KNOWLEDGE_DELIVERY_DIR?.trim();
  return override
    ? pathResolver.rootResolve(override)
    : pathResolver.shared('runtime/feedback-loop/knowledge-delivery');
}

function usageAggregatePath(): string {
  const override = process.env.KYBERION_KNOWLEDGE_USAGE_PATH?.trim();
  if (override) return pathResolver.rootResolve(override);
  return pathResolver.shared('runtime/feedback-loop/knowledge-usage/usage.json');
}

export function knowledgeDeliveryLogDir(): string {
  return deliveryLogDir();
}

export function knowledgeUsageAggregatePath(): string {
  return usageAggregatePath();
}

function normalizeRefs(refs: DeliveredKnowledgeRef[]): DeliveredKnowledgeRef[] {
  const seen = new Set<string>();
  const normalized: DeliveredKnowledgeRef[] = [];
  for (const ref of refs) {
    const p = String(ref?.path || '').trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    normalized.push({
      path: p,
      ...(typeof ref.score === 'number' ? { score: ref.score } : {}),
      ...(ref.title ? { title: String(ref.title).trim() } : {}),
    });
  }
  return normalized;
}

function normalizeTopicList(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    const trimmed = String(item || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function loadUsageAggregate(): KnowledgeUsageAggregateEntry[] {
  const filePath = usageAggregatePath();
  if (!safeExistsSync(filePath)) return [];
  try {
    const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveUsageAggregate(entries: KnowledgeUsageAggregateEntry[]): void {
  const filePath = usageAggregatePath();
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(filePath, JSON.stringify(entries, null, 2));
}

/**
 * Read-modify-write one path's counters into the shared usage aggregate.
 * Not exported: `recordKnowledgeDelivery` / `recordKnowledgeUsageFeedback`
 * are the only callers, so every counter mutation stays paired with the
 * event that justified it.
 */
function bumpUsageAggregate(
  documentPath: string,
  delta: Partial<
    Pick<KnowledgeUsageAggregateEntry, 'delivered_count' | 'used_count' | 'not_used_count'>
  >,
  at: string
): void {
  const entries = loadUsageAggregate();
  const index = entries.findIndex((entry) => entry.document_path === documentPath);
  if (index >= 0) {
    const current = entries[index];
    entries[index] = {
      ...current,
      delivered_count: current.delivered_count + (delta.delivered_count || 0),
      used_count: current.used_count + (delta.used_count || 0),
      not_used_count: current.not_used_count + (delta.not_used_count || 0),
      occurrences: current.occurrences + 1,
      last_seen: at,
    };
  } else {
    entries.push({
      document_path: documentPath,
      delivered_count: delta.delivered_count || 0,
      used_count: delta.used_count || 0,
      not_used_count: delta.not_used_count || 0,
      occurrences: 1,
      last_seen: at,
    });
  }
  saveUsageAggregate(entries);
}

/**
 * Record that `provisionTaskKnowledge` delivered `refs` to a task. No-op
 * (returns undefined) when there is nothing to record — most tasks resolve
 * without knowledge hints and should not grow the delivery log.
 *
 * TODO(KP-05 acceptance 1): also attach these refs to the active trace
 * span's `knowledgeRefs` (`TraceContext.addKnowledgeRef`, src/trace.ts).
 * `mission-orchestration-worker.ts`'s dispatch path does not currently open
 * a `TraceContext` around task dispatch (only actuator/pipeline flows do via
 * `actuator-trace.ts`), so there is no live span to attach to here without
 * inventing a new tracing seam for this task. The delivery log below is the
 * durable record until that span exists; wire the two together when the
 * dispatch path gains trace instrumentation.
 */
export function recordKnowledgeDelivery(input: {
  missionId: string;
  taskId?: string;
  teamRole?: string;
  recipientKind?: string;
  refs: DeliveredKnowledgeRef[];
}): { deliveryRecordPath: string; refs: DeliveredKnowledgeRef[] } | undefined {
  const refs = normalizeRefs(input.refs || []);
  if (refs.length === 0) return undefined;

  const dir = deliveryLogDir();
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const filePath = path.join(dir, `delivery-${day}.jsonl`);
  const record: KnowledgeDeliveryRecord = {
    mission_id: input.missionId,
    ...(input.taskId ? { task_id: input.taskId } : {}),
    ...(input.teamRole ? { team_role: input.teamRole } : {}),
    ...(input.recipientKind ? { recipient_kind: input.recipientKind } : {}),
    delivered_at: now,
    refs,
  };

  try {
    safeAppendFileSync(filePath, `${JSON.stringify(record)}\n`);
    for (const ref of refs) {
      bumpUsageAggregate(ref.path, { delivered_count: 1 }, now);
    }
  } catch (error: any) {
    // Delivery telemetry must never block task dispatch (fail-open, same
    // contract as the rest of the feedback loop — see runFeedbackLoop).
    logger.warn(`[KP-05] Failed to record knowledge delivery: ${error?.message ?? String(error)}`);
    return undefined;
  }

  return { deliveryRecordPath: filePath, refs };
}

/**
 * Fold a task_result's `knowledge_feedback` into the usage aggregate and
 * enqueue `missing_topics` as knowledge-gap promotion candidates. Called
 * once per received task_result that actually carries the (optional) field
 * — absent/empty feedback is a no-op.
 */
export function recordKnowledgeUsageFeedback(input: {
  missionId: string;
  taskId?: string;
  feedback: TaskResultKnowledgeFeedback | undefined;
}): { usageUpdated: boolean; promotionCandidateIds: string[] } {
  const feedback = input.feedback;
  if (!feedback) return { usageUpdated: false, promotionCandidateIds: [] };

  const used = normalizeTopicList(feedback.used);
  const notUsed = normalizeTopicList(feedback.not_used).filter((path) => !used.includes(path));
  const missingTopics = normalizeTopicList(feedback.missing_topics);
  const now = new Date().toISOString();

  let usageUpdated = false;
  try {
    for (const documentPath of used) {
      bumpUsageAggregate(documentPath, { used_count: 1 }, now);
      usageUpdated = true;
    }
    for (const documentPath of notUsed) {
      bumpUsageAggregate(documentPath, { not_used_count: 1 }, now);
      usageUpdated = true;
    }
  } catch (error: any) {
    logger.warn(
      `[KP-05] Failed to record knowledge usage feedback: ${error?.message ?? String(error)}`
    );
  }

  const promotionCandidateIds: string[] = [];
  const sourceRef = input.taskId
    ? `mission:${input.missionId}:task:${input.taskId}`
    : `mission:${input.missionId}`;
  for (const topic of missingTopics) {
    try {
      const candidate = createMemoryPromotionCandidate({
        sourceType: 'task_session',
        sourceRef,
        // Closest existing kind (memory-candidate.schema.json enum) for "a
        // document/topic that was needed but not found" — a prompt to
        // clarify/author knowledge, not yet a validated SOP/heuristic.
        proposedMemoryKind: 'clarification_prompt',
        summary: `Knowledge gap reported by ${sourceRef}: ${topic}`,
        evidenceRefs: [sourceRef],
        sensitivityTier: 'confidential',
        ratificationRequired: true,
      });
      enqueueMemoryPromotionCandidate(candidate);
      promotionCandidateIds.push(candidate.candidate_id);
    } catch (error: any) {
      logger.warn(
        `[KP-05] Failed to enqueue knowledge-gap candidate for "${topic}": ${error?.message ?? String(error)}`
      );
    }
  }

  return { usageUpdated, promotionCandidateIds };
}

export function loadKnowledgeUsageAggregate(): KnowledgeUsageAggregateEntry[] {
  return loadUsageAggregate();
}
