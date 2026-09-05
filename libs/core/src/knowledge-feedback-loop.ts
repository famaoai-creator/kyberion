import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
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

import { getRegisteredEnvText } from '../foundation/env.js';
import * as path from 'node:path';
import { nowIso } from '../foundation/time.js';
import { logger } from '../core.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir } from '../secure-io.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
} from '../memory-promotion-queue.js';
import type { TaskResultKnowledgeFeedback } from '../channel-surface-types.js';
import { scopeContextKey, type ScopeContext } from '../scope-context.js';
import { physicalScopedPath } from '../physical-namespace.js';
import {
  loadKnowledgeUsageAggregateAtPath,
  writeKnowledgeUsageAggregateAtPath,
  type KnowledgeUsageAggregateEntry,
} from '../knowledge-usage-aggregate.js';

export type { KnowledgeUsageAggregateEntry } from '../knowledge-usage-aggregate.js';

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
  scope_context?: ScopeContext;
  scope_disposition?: 'canonical' | 'unscoped-legacy';
}

export interface HumanKnowledgeFeedback {
  document_path: string;
  verdict: 'useful' | 'stale' | 'wrong' | 'not_useful';
  reason?: string;
  actor?: string;
  source?: string;
  scope?: ScopeContext;
}

export interface SlackKnowledgeReactionInput {
  reaction: string;
  document_path: string;
  actor?: string;
  channel?: string;
  message_ts?: string;
  tenant_slug?: string;
}

/** Map an inbound Slack reaction to the same governed human-feedback record used by UI/MCP. */
export function recordSlackKnowledgeReaction(
  input: SlackKnowledgeReactionInput
): string | undefined {
  const reaction = input.reaction.trim().toLowerCase();
  const verdict = ['thumbsup', '+1', 'white_check_mark', 'heavy_check_mark'].includes(reaction)
    ? 'useful'
    : ['thumbsdown', '-1', 'x', 'heavy_multiplication_x'].includes(reaction)
      ? 'not_useful'
      : undefined;
  if (!verdict) return undefined;
  const documentPath = input.document_path.trim();
  const isConfidential = documentPath.startsWith('knowledge/confidential/');
  return recordHumanKnowledgeFeedback({
    document_path: documentPath,
    verdict,
    actor: input.actor,
    source: `slack:reaction:${input.channel || 'unknown'}:${input.message_ts || 'unknown'}`,
    ...(input.tenant_slug || isConfidential
      ? {
          scope: {
            tier: isConfidential ? ('confidential' as const) : ('public' as const),
            ...(input.tenant_slug ? { tenant_slug: input.tenant_slug } : {}),
          },
        }
      : {}),
  });
}

export interface KnowledgeGapRecord {
  topic: string;
  source_ref: string;
  recorded_at: string;
  scope?: ScopeContext;
}

export interface KnowledgeFeedbackCap {
  max_usage_entries: number;
  max_usage_bytes: number;
}

const DEFAULT_KNOWLEDGE_FEEDBACK_CAP: KnowledgeFeedbackCap = {
  max_usage_entries: 10_000,
  max_usage_bytes: 10 * 1024 * 1024,
};

interface KnowledgeFeedbackPolicyFile {
  version?: string;
  description?: string;
  defaults?: Partial<KnowledgeFeedbackCap>;
  tenant_overrides?: Record<string, Partial<KnowledgeFeedbackCap>>;
}

function feedbackPolicyPath(): string {
  const override = getRegisteredEnvText('KYBERION_KNOWLEDGE_FEEDBACK_POLICY_PATH')?.trim();
  const canonical = pathResolver.knowledge('product/governance/knowledge-feedback-policy.json');
  if (!override) return canonical;
  try {
    return assertSafeRepositoryPath(pathResolver.rootResolve(override), {
      allowMissingLeaf: true,
    });
  } catch (error) {
    logger.warn(`[KP-05] ignoring unsafe knowledge feedback policy override: ${String(error)}`);
    return canonical;
  }
}

const knowledgeFeedbackPolicyCatalog = defineCatalog<KnowledgeFeedbackPolicyFile>({
  id: 'knowledge-feedback-policy',
  path: feedbackPolicyPath,
  schema: pathResolver.knowledge('product/schemas/knowledge-feedback-policy.schema.json'),
});

export function loadKnowledgeFeedbackCap(scope?: ScopeContext): KnowledgeFeedbackCap {
  const filePath = feedbackPolicyPath();
  if (!safeExistsSync(filePath)) return { ...DEFAULT_KNOWLEDGE_FEEDBACK_CAP };
  const parsed = knowledgeFeedbackPolicyCatalog.load();
  const override = scope?.tenant_slug ? parsed.tenant_overrides?.[scope.tenant_slug] : undefined;
  const values = {
    ...DEFAULT_KNOWLEDGE_FEEDBACK_CAP,
    ...(parsed.defaults || {}),
    ...(override || {}),
  };
  return {
    max_usage_entries:
      typeof values.max_usage_entries === 'number' && values.max_usage_entries > 0
        ? Math.floor(values.max_usage_entries)
        : DEFAULT_KNOWLEDGE_FEEDBACK_CAP.max_usage_entries,
    max_usage_bytes:
      typeof values.max_usage_bytes === 'number' && values.max_usage_bytes > 0
        ? Math.floor(values.max_usage_bytes)
        : DEFAULT_KNOWLEDGE_FEEDBACK_CAP.max_usage_bytes,
  };
}

function scopedRuntimePath(base: string, scope?: ScopeContext): string {
  if (!scope?.tenant_slug) return base;
  try {
    const eventScope = {
      ...scope,
      scope_kind: scope.session_id
        ? 'session'
        : scope.task_id
          ? 'task'
          : scope.mission_id
            ? 'mission'
            : scope.project_id
              ? 'project'
              : scope.organization_id
                ? 'organization'
                : 'tenant',
    } as const;
    const rootDir = pathResolver.rootDir();
    const relativeBase = path.relative(rootDir, base).replace(/\\/g, '/');
    const feedbackRoot = 'active/shared/runtime/feedback-loop';
    if (relativeBase === feedbackRoot || relativeBase.startsWith(`${feedbackRoot}/`)) {
      const suffix = relativeBase.slice(feedbackRoot.length).replace(/^\/+/, '');
      return assertSafeRepositoryPath(
        pathResolver.rootResolve(
          path.posix.join(
            physicalScopedPath(feedbackRoot, eventScope),
            ...(suffix ? suffix.split('/') : [])
          )
        ),
        { allowMissingLeaf: true }
      );
    }
    return assertSafeRepositoryPath(
      pathResolver.rootResolve(physicalScopedPath(relativeBase, eventScope)),
      { allowMissingLeaf: true }
    );
  } catch {
    return assertSafeRepositoryPath(base, { allowMissingLeaf: true });
  }
}

function safeRuntimeOverride(override: string | undefined, fallback: string): string {
  if (override) {
    try {
      return assertSafeRepositoryPath(pathResolver.rootResolve(override), {
        allowMissingLeaf: true,
      });
    } catch (error) {
      logger.warn(`[KP-05] ignoring unsafe runtime path override: ${String(error)}`);
    }
  }
  return assertSafeRepositoryPath(fallback, { allowMissingLeaf: true });
}

function deliveryLogDir(scope?: ScopeContext): string {
  const override = getRegisteredEnvText('KYBERION_KNOWLEDGE_DELIVERY_DIR')?.trim();
  const base = safeRuntimeOverride(
    override,
    pathResolver.shared('runtime/feedback-loop/knowledge-delivery')
  );
  return scopedRuntimePath(base, scope);
}

function usageAggregatePath(scope?: ScopeContext): string {
  const override = getRegisteredEnvText('KYBERION_KNOWLEDGE_USAGE_PATH')?.trim();
  const base = safeRuntimeOverride(
    override,
    pathResolver.shared('runtime/feedback-loop/knowledge-usage/usage.json')
  );
  if (!scope?.tenant_slug) return base;
  const directory = scopedRuntimePath(path.dirname(base), scope);
  return assertSafeRepositoryPath(path.join(directory, path.basename(base)), {
    allowMissingLeaf: true,
  });
}

export function knowledgeDeliveryLogDir(scope?: ScopeContext): string {
  return deliveryLogDir(scope);
}

export function knowledgeUsageAggregatePath(scope?: ScopeContext): string {
  return usageAggregatePath(scope);
}

function scopedFeedbackPath(kind: 'human' | 'gaps', scope?: ScopeContext): string {
  const feedbackDir = getRegisteredEnvText('KYBERION_KNOWLEDGE_FEEDBACK_DIR')?.trim();
  const base = safeRuntimeOverride(feedbackDir, pathResolver.shared('runtime/feedback-loop'));
  const scopedDirectory = scopedRuntimePath(base, scope);
  return assertSafeRepositoryPath(path.join(scopedDirectory, `knowledge-${kind}.jsonl`), {
    allowMissingLeaf: true,
  });
}

export function recordHumanKnowledgeFeedback(input: HumanKnowledgeFeedback): string {
  const documentPath = input.document_path.trim();
  if (!documentPath) throw new Error('[KNOWLEDGE_FEEDBACK_INVALID] document_path is required');
  const logicalPath = documentPath.replaceAll('\\', '/');
  if (logicalPath.startsWith('/') || logicalPath.split('/').includes('..')) {
    throw new Error('[KNOWLEDGE_FEEDBACK_INVALID] document_path must be repository-relative');
  }
  const confidentialPrefix = 'knowledge/confidential/';
  if (logicalPath.startsWith(confidentialPrefix)) {
    const owner = logicalPath.slice(confidentialPrefix.length).split('/')[0];
    const sharedOwners = new Set(['common', 'tenant-groups']);
    if (!input.scope?.tenant_slug) {
      throw new Error(
        '[SCOPE_CONTEXT_INVALID] Confidential knowledge feedback requires a resolved tenant scope'
      );
    }
    if (owner !== input.scope.tenant_slug && !sharedOwners.has(owner)) {
      throw new Error(
        `[SCOPE_CONTEXT_INVALID] Knowledge feedback path belongs to tenant '${owner}', not '${input.scope.tenant_slug}'`
      );
    }
  }
  const record = {
    document_path: documentPath,
    verdict: input.verdict,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    ...(input.actor?.trim() ? { actor: input.actor.trim() } : {}),
    ...(input.source?.trim() ? { source: input.source.trim() } : {}),
    recorded_at: nowIso(),
    ...(input.scope ? { scope: input.scope } : {}),
  };
  const target = scopedFeedbackPath('human', input.scope);
  const dir = path.dirname(target);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  appendJsonLine(target, record);
  bumpUsageAggregate(
    documentPath,
    input.verdict === 'useful' ? { used_count: 1 } : { not_used_count: 1 },
    record.recorded_at,
    input.scope
  );
  return target;
}

export function recordKnowledgeGap(input: {
  topic: string;
  sourceRef: string;
  scope?: ScopeContext;
  promoteOnCluster?: boolean;
}): string | undefined {
  const topic = input.topic.trim();
  const sourceRef = input.sourceRef.trim();
  if (!topic || !sourceRef) return undefined;
  const record: KnowledgeGapRecord = {
    topic,
    source_ref: sourceRef,
    recorded_at: nowIso(),
    ...(input.scope ? { scope: input.scope } : {}),
  };
  const target = scopedFeedbackPath('gaps', input.scope);
  const dir = path.dirname(target);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  let priorCount = 0;
  if (safeExistsSync(target)) {
    try {
      priorCount = readJsonLines<KnowledgeGapRecord>(target, { onMalformed: 'skip' }).filter(
        (row) =>
          row.topic === topic &&
          JSON.stringify(row.scope || {}) === JSON.stringify(input.scope || {})
      ).length;
    } catch {
      priorCount = 0;
    }
  }
  appendJsonLine(target, record);
  if (input.promoteOnCluster && priorCount + 1 === 3) {
    try {
      const candidate = createMemoryPromotionCandidate({
        sourceType: 'task_session',
        sourceRef,
        proposedMemoryKind: 'clarification_prompt',
        summary: `Repeated scoped knowledge gap (3 observations): ${topic}`,
        evidenceRefs: [sourceRef, target],
        sensitivityTier: 'confidential',
        ratificationRequired: true,
        ...(input.scope
          ? {
              scope: {
                ...input.scope,
                tier: 'confidential',
                promotion_policy: 'same_scope' as const,
                provenance_refs: [sourceRef, target],
              },
            }
          : {}),
      });
      enqueueMemoryPromotionCandidate(candidate);
    } catch (error: any) {
      logger.warn(
        `[KP-05] Failed to enqueue clustered knowledge gap: ${error?.message ?? String(error)}`
      );
    }
  }
  return target;
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

function loadUsageAggregate(scope?: ScopeContext): KnowledgeUsageAggregateEntry[] {
  const filePath = usageAggregatePath(scope);
  try {
    return loadKnowledgeUsageAggregateAtPath(filePath);
  } catch {
    return [];
  }
}

function saveUsageAggregate(entries: KnowledgeUsageAggregateEntry[], scope?: ScopeContext): void {
  const filePath = usageAggregatePath(scope);
  writeKnowledgeUsageAggregateAtPath(filePath, entries);
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
  at: string,
  scope?: ScopeContext
): void {
  const entries = loadUsageAggregate(scope);
  const cap = loadKnowledgeFeedbackCap(scope);
  const index = entries.findIndex((entry) => entry.document_path === documentPath);
  if (index >= 0) {
    const current = entries[index];
    entries[index] = {
      ...current,
      ...(scope ? { scope_context_key: scopeContextKey(scope) } : {}),
      delivered_count: current.delivered_count + (delta.delivered_count || 0),
      used_count: current.used_count + (delta.used_count || 0),
      not_used_count: current.not_used_count + (delta.not_used_count || 0),
      occurrences: current.occurrences + 1,
      last_seen: at,
    };
  } else {
    if (entries.length >= cap.max_usage_entries) {
      logger.warn(
        `[KP-05] usage aggregate entry cap reached (${cap.max_usage_entries}); delivery telemetry remains in JSONL but ranking aggregate was not expanded`
      );
      return;
    }
    entries.push({
      document_path: documentPath,
      ...(scope ? { scope_context_key: scopeContextKey(scope) } : {}),
      delivered_count: delta.delivered_count || 0,
      used_count: delta.used_count || 0,
      not_used_count: delta.not_used_count || 0,
      occurrences: 1,
      last_seen: at,
    });
  }
  const serialized = JSON.stringify(entries, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > cap.max_usage_bytes) {
    logger.warn(
      `[KP-05] usage aggregate byte cap reached (${cap.max_usage_bytes}); delivery telemetry remains in JSONL but ranking aggregate was not expanded`
    );
    return;
  }
  saveUsageAggregate(entries, scope);
}

/**
 * Record that `provisionTaskKnowledge` delivered `refs` to a task. No-op
 * (returns undefined) when there is nothing to record — most tasks resolve
 * without knowledge hints and should not grow the delivery log.
 *
 * KP-05 acceptance 1 (done): `mission-orchestration-worker.ts` now opens a
 * `mission_task_dispatch` TraceContext span around every task dispatch
 * (single-shot via `dispatchPlannedMissionTaskCore`, goal-driven via
 * `dispatchGoalDrivenMissionTask`) and attaches this call's returned
 * `deliveredKnowledgeRefs` to it via `attachDeliveredKnowledgeRefs`
 * (`TraceContext.addKnowledgeRef` for paths + a `knowledge_delivered` event
 * carrying per-ref scores, since the trace schema's `knowledgeRefs` field is
 * `string[]`-only). The span is persisted through the same `persistTrace`
 * JSONL store actuator/pipeline traces use (`src/trace.ts`). The delivery
 * log below remains the durable, queryable record independent of trace
 * retention/rotation.
 */
export function recordKnowledgeDelivery(input: {
  missionId: string;
  taskId?: string;
  teamRole?: string;
  recipientKind?: string;
  refs: DeliveredKnowledgeRef[];
  scope?: ScopeContext;
}): { deliveryRecordPath: string; refs: DeliveredKnowledgeRef[] } | undefined {
  const refs = normalizeRefs(input.refs || []);
  if (refs.length === 0) return undefined;

  const dir = deliveryLogDir(input.scope);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  const now = nowIso();
  const day = now.slice(0, 10);
  const filePath = path.join(dir, `delivery-${day}.jsonl`);
  const record: KnowledgeDeliveryRecord = {
    mission_id: input.missionId,
    ...(input.taskId ? { task_id: input.taskId } : {}),
    ...(input.teamRole ? { team_role: input.teamRole } : {}),
    ...(input.recipientKind ? { recipient_kind: input.recipientKind } : {}),
    delivered_at: now,
    refs,
    ...(input.scope
      ? { scope_context: input.scope, scope_disposition: 'canonical' as const }
      : { scope_disposition: 'unscoped-legacy' as const }),
  };

  try {
    appendJsonLine(filePath, record);
    for (const ref of refs) {
      bumpUsageAggregate(ref.path, { delivered_count: 1 }, now, input.scope);
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
  scope?: ScopeContext;
}): { usageUpdated: boolean; promotionCandidateIds: string[] } {
  const feedback = input.feedback;
  if (!feedback) return { usageUpdated: false, promotionCandidateIds: [] };

  const used = normalizeTopicList(feedback.used);
  const notUsed = normalizeTopicList(feedback.not_used).filter((path) => !used.includes(path));
  const missingTopics = normalizeTopicList(feedback.missing_topics);
  const now = nowIso();

  let usageUpdated = false;
  try {
    for (const documentPath of used) {
      bumpUsageAggregate(documentPath, { used_count: 1 }, now, input.scope);
      usageUpdated = true;
    }
    for (const documentPath of notUsed) {
      bumpUsageAggregate(documentPath, { not_used_count: 1 }, now, input.scope);
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
      recordKnowledgeGap({ topic, sourceRef, scope: input.scope });
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
        ...(input.scope
          ? {
              scope: {
                ...input.scope,
                tier: 'confidential',
                promotion_policy: 'same_scope' as const,
                provenance_refs: [sourceRef],
              },
            }
          : {}),
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

export function loadKnowledgeUsageAggregate(scope?: ScopeContext): KnowledgeUsageAggregateEntry[] {
  return loadUsageAggregate(scope);
}
