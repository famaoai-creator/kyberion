import { randomUUID } from 'node:crypto';
import { withLockSync } from '../foundation/lock-utils.js';
import {
  createKnowledgeDeliverySnapshot,
  knowledgeAttributionScopeKey,
  knowledgeTextSha256,
  validKnowledgeDeliverySnapshot,
  type KnowledgeDeliverySnapshot,
} from './knowledge-delivery-snapshot.js';
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
 * `./memory-promotion-queue.ts`).
 *
 * See docs/developer/improvement-plans-2026-07/
 * TASK_KNOWLEDGE_PROVISIONING_PLAN_2026-07-25.ja.md §KP-05.
 */

import { getRegisteredEnvText } from '../foundation/env.js';
import * as path from 'node:path';
import { nowIso } from '../foundation/time.js';
import { logger } from '../core.js';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
} from '../secure-io.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
} from './memory-promotion-queue.js';
import type { TaskResultKnowledgeFeedback } from '../surface/channel-surface-types.js';
import { assertMemoryScope, type MemoryScopeEnvelope } from './memory-scope.js';
import { physicalScopedPath } from '../physical-namespace.js';
import {
  recordKnowledgeProblem,
  recordKnowledgeReuseObservation,
} from './knowledge-verification.js';
import {
  loadKnowledgeUsageAggregateAtPath,
  writeKnowledgeUsageAggregateAtPath,
  type KnowledgeUsageAggregateEntry,
} from './knowledge-usage-aggregate.js';

export type { KnowledgeUsageAggregateEntry } from './knowledge-usage-aggregate.js';

export interface DeliveredKnowledgeRef {
  path: string;
  score?: number;
  title?: string;
  snapshot?: KnowledgeDeliverySnapshot;
  delivery_id?: string;
  scope_context?: MemoryScopeEnvelope;
}

export interface KnowledgeDeliveryRecord {
  delivery_id?: string;
  mission_id: string;
  task_id?: string;
  team_role?: string;
  recipient_kind?: string;
  delivered_at: string;
  refs: DeliveredKnowledgeRef[];
  scope_context?: MemoryScopeEnvelope;
  scope_disposition?: 'canonical' | 'unscoped-legacy';
}

export interface HumanKnowledgeFeedback {
  document_path: string;
  verdict: 'useful' | 'stale' | 'wrong' | 'not_useful';
  reason?: string;
  actor?: string;
  source?: string;
  scope?: MemoryScopeEnvelope;
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
  scope?: MemoryScopeEnvelope;
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

export function loadKnowledgeFeedbackCap(scope?: MemoryScopeEnvelope): KnowledgeFeedbackCap {
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

function scopedRuntimePath(base: string, scope?: MemoryScopeEnvelope, personalSuffix = ''): string {
  if (scope?.tier === 'personal') {
    const canonical = assertMemoryScope(scope);
    if (!canonical.owner_nhi)
      throw new Error(
        '[KNOWLEDGE_FEEDBACK_OWNER_REQUIRED] Personal feedback requires explicit owner_nhi'
      );
    // Runtime overrides and tenant context must never move private feedback to a shared floor.
    return assertSafeRepositoryPath(
      pathResolver.rootResolve(
        path.posix.join(
          'active/personal/owners',
          knowledgeTextSha256(canonical.owner_nhi),
          'feedback-loop',
          knowledgeTextSha256(JSON.stringify(canonical)),
          personalSuffix
        )
      ),
      { allowMissingLeaf: true }
    );
  }
  if (!scope?.tenant_slug) return base;
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
  const relativeBase = path.relative(rootDir, base).replaceAll('\\', '/');
  const feedbackRoot = 'active/shared/runtime/feedback-loop';
  if (relativeBase === feedbackRoot || relativeBase.startsWith(feedbackRoot + '/')) {
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
  // Invalid scoped paths fail closed, never retry against the unscoped base.
  return assertSafeRepositoryPath(
    pathResolver.rootResolve(physicalScopedPath(relativeBase, eventScope)),
    { allowMissingLeaf: true }
  );
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

function deliveryLogDir(scope?: MemoryScopeEnvelope): string {
  const override = getRegisteredEnvText('KYBERION_KNOWLEDGE_DELIVERY_DIR')?.trim();
  const base = safeRuntimeOverride(
    override,
    pathResolver.shared('runtime/feedback-loop/knowledge-delivery')
  );
  return scopedRuntimePath(base, scope, 'knowledge-delivery');
}

function usageAggregatePath(scope?: MemoryScopeEnvelope): string {
  const override = getRegisteredEnvText('KYBERION_KNOWLEDGE_USAGE_PATH')?.trim();
  const base = safeRuntimeOverride(
    override,
    pathResolver.shared('runtime/feedback-loop/knowledge-usage/usage.json')
  );
  if (scope?.tier === 'personal')
    return scopedRuntimePath(base, scope, 'knowledge-usage/usage.json');
  if (!scope?.tenant_slug) return base;
  // The aggregate is a tenant-level ranking signal (weight proposals, curation
  // and usage_yield all read it per tenant). Writers sit at mission or task
  // scope, so partitioning by the full chain left every reader looking at a
  // file no writer touched. The JSONL delivery log keeps the full chain.
  const tenantScope: MemoryScopeEnvelope = { tier: scope.tier, tenant_slug: scope.tenant_slug };
  const directory = scopedRuntimePath(path.dirname(base), tenantScope);
  return assertSafeRepositoryPath(path.join(directory, path.basename(base)), {
    allowMissingLeaf: true,
  });
}

export function knowledgeDeliveryLogDir(scope?: MemoryScopeEnvelope): string {
  return deliveryLogDir(scope);
}

export function knowledgeUsageAggregatePath(scope?: MemoryScopeEnvelope): string {
  return usageAggregatePath(scope);
}

function scopedFeedbackPath(kind: 'human' | 'gaps' | 'usage', scope?: MemoryScopeEnvelope): string {
  const feedbackDir = getRegisteredEnvText('KYBERION_KNOWLEDGE_FEEDBACK_DIR')?.trim();
  const base = safeRuntimeOverride(feedbackDir, pathResolver.shared('runtime/feedback-loop'));
  const scopedDirectory = scopedRuntimePath(base, scope);
  return assertSafeRepositoryPath(path.join(scopedDirectory, `knowledge-${kind}.jsonl`), {
    allowMissingLeaf: true,
  });
}

function ensureRegularFeedbackFile(filePath: string): void {
  if (safeExistsSync(filePath) && !safeLstat(filePath).isFile()) {
    throw new Error(
      `[KNOWLEDGE_FEEDBACK_INVALID] feedback log must be a regular file: ${filePath}`
    );
  }
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
  ensureRegularFeedbackFile(target);
  appendJsonLine(target, record);
  // The verification ledger has no owner partition. Keep personal reports only
  // in the owner-scoped receipt and aggregate until that sink supports owners.
  if (
    input.scope?.tier !== 'personal' &&
    (input.verdict === 'wrong' || input.verdict === 'stale')
  ) {
    recordKnowledgeProblem({
      documentPath,
      kind: input.verdict,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.scope?.tenant_slug
        ? { scope: { tier: input.scope.tier, tenant_slug: input.scope.tenant_slug } }
        : {}),
      at: record.recorded_at,
    });
  }
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
  scope?: MemoryScopeEnvelope;
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
  ensureRegularFeedbackFile(target);
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
                // Source scope is not the conservative destination sensitivity tier.
                ...input.scope,
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
      ...(validKnowledgeDeliverySnapshot(ref.snapshot)
        ? { snapshot: createKnowledgeDeliverySnapshot({ ...ref.snapshot }) }
        : {}),
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

function loadUsageAggregate(scope?: MemoryScopeEnvelope): KnowledgeUsageAggregateEntry[] {
  const filePath = usageAggregatePath(scope);
  try {
    return loadKnowledgeUsageAggregateAtPath(filePath);
  } catch {
    return [];
  }
}

function saveUsageAggregate(
  entries: KnowledgeUsageAggregateEntry[],
  scope?: MemoryScopeEnvelope
): void {
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
  scope?: MemoryScopeEnvelope
): void {
  const entries = loadUsageAggregate(scope);
  const cap = loadKnowledgeFeedbackCap(scope);
  // Advisory tenant-level ranking only. Exact attribution belongs to scoped receipts.
  const aggregateScope = scope?.tenant_slug
    ? { tier: scope.tier, tenant_slug: scope.tenant_slug }
    : scope
      ? { tier: scope.tier }
      : undefined;
  const index = entries.findIndex((entry) => entry.document_path === documentPath);
  if (index >= 0) {
    const current = entries[index];
    entries[index] = {
      ...current,
      ...(scope ? { scope_context_key: knowledgeAttributionScopeKey(aggregateScope) } : {}),
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
      ...(scope ? { scope_context_key: knowledgeAttributionScopeKey(aggregateScope) } : {}),
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
  scope?: MemoryScopeEnvelope;
}): { deliveryRecordPath: string; refs: DeliveredKnowledgeRef[] } | undefined {
  const deliveryId = randomUUID();
  const refs = normalizeRefs(input.refs || []).map((ref) => ({
    ...ref,
    delivery_id: deliveryId,
    ...(input.scope ? { scope_context: { ...input.scope } } : {}),
  }));
  if (refs.length === 0) return undefined;

  const dir = deliveryLogDir(input.scope);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  const now = nowIso();
  const day = now.slice(0, 10);
  const filePath = path.join(dir, `delivery-${day}.jsonl`);
  const record: KnowledgeDeliveryRecord = {
    delivery_id: deliveryId,
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
    ensureRegularFeedbackFile(filePath);
    appendJsonLine(filePath, record);
    recordKnowledgeReuseObservation({
      documentSnapshots: refs,
      receiptId: knowledgeTextSha256(deliveryId),
      kind: 'delivered',
      scope: input.scope,
      at: now,
    });
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

/** Resolve only receipts persisted for this exact dispatch scope and task. */
function deliveredRefsForFeedback(input: {
  missionId: string;
  taskId?: string;
  scope?: MemoryScopeEnvelope;
  deliveredRefs?: DeliveredKnowledgeRef[];
}): DeliveredKnowledgeRef[] {
  const dir = deliveryLogDir(input.scope);
  if (!safeExistsSync(dir)) return [];
  const refs: DeliveredKnowledgeRef[] = [];
  for (const name of safeReaddir(dir).filter((name) =>
    /^delivery-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)
  )) {
    const file = path.join(dir, name);
    ensureRegularFeedbackFile(file);
    for (const record of readJsonLines<KnowledgeDeliveryRecord>(file, { onMalformed: 'skip' })) {
      if (
        record.mission_id !== input.missionId ||
        record.task_id !== input.taskId ||
        knowledgeAttributionScopeKey(record.scope_context) !==
          knowledgeAttributionScopeKey(input.scope)
      )
        continue;
      for (const ref of record.refs || []) {
        if (!record.delivery_id || ref.delivery_id !== record.delivery_id) continue;
        if (
          input.deliveredRefs &&
          !input.deliveredRefs.some(
            (expected) =>
              expected.delivery_id === ref.delivery_id &&
              expected.path === ref.path &&
              expected.snapshot?.sha256 === ref.snapshot?.sha256 &&
              knowledgeAttributionScopeKey(expected.scope_context) ===
                knowledgeAttributionScopeKey(input.scope)
          )
        )
          continue;
        refs.push(ref);
      }
    }
  }
  // A path-only worker claim cannot disambiguate two delivered versions.
  return refs.filter(
    (ref, index) =>
      refs.findIndex((other) => other.path === ref.path) === index &&
      !refs.some(
        (other) => other.path === ref.path && other.snapshot?.sha256 !== ref.snapshot?.sha256
      )
  );
}

/**
 * Fold a task_result's `knowledge_feedback` into the usage aggregate and
 * enqueue `missing_topics` as knowledge-gap promotion candidates. Called
 * once per received task_result that actually carries the (optional) field
 * — absent/empty feedback is a no-op.
 */
export function recordKnowledgeUsageFeedback(
  input: Parameters<typeof recordKnowledgeUsageFeedbackUnlocked>[0]
): ReturnType<typeof recordKnowledgeUsageFeedbackUnlocked> {
  try {
    const aggregatePath = usageAggregatePath(input.scope);
    // New private paths carry two hashes; do not exceed the lock filename limit.
    // Preserve existing shared lock identities for rolling-version compatibility.
    const lockResource =
      input.scope?.tier === 'personal' ? knowledgeTextSha256(aggregatePath) : aggregatePath;
    return withLockSync('knowledge-usage:' + lockResource, () =>
      recordKnowledgeUsageFeedbackUnlocked(input)
    );
  } catch (error) {
    logger.warn(
      '[KP-05] usage receipt not recorded — ' +
        String(error) +
        ' | next: inspect feedback storage and lock contention'
    );
    return { usageUpdated: false, promotionCandidateIds: [] };
  }
}

function recordKnowledgeUsageFeedbackUnlocked(input: {
  missionId: string;
  taskId?: string;
  feedback: TaskResultKnowledgeFeedback | undefined;
  scope?: MemoryScopeEnvelope;
  deliveredRefs?: DeliveredKnowledgeRef[];
  resultId?: string;
  outcome?: 'worker_report_complete' | 'incomplete';
}): {
  usageUpdated: boolean;
  promotionCandidateIds: string[];
  usedRefs?: DeliveredKnowledgeRef[];
  receiptId?: string;
} {
  const feedback = input.feedback;
  if (!feedback) return { usageUpdated: false, promotionCandidateIds: [] };

  let delivered: DeliveredKnowledgeRef[];
  try {
    delivered = deliveredRefsForFeedback(input);
  } catch {
    delivered = [];
  }
  const allowedPaths = new Set(delivered.map((ref) => ref.path));
  const used = normalizeTopicList(feedback.used).filter((path) => allowedPaths.has(path));
  const notUsed = normalizeTopicList(feedback.not_used).filter(
    (path) => allowedPaths.has(path) && !used.includes(path)
  );
  const usedRefs = delivered.filter((ref) => used.includes(ref.path));
  const receiptId = input.resultId
    ? knowledgeTextSha256(
        JSON.stringify([
          input.missionId,
          input.taskId,
          knowledgeAttributionScopeKey(input.scope),
          input.resultId,
          input.outcome || 'incomplete',
          delivered.map((ref) => [ref.delivery_id, ref.path, ref.snapshot?.sha256]),
        ])
      )
    : undefined;
  const usageLog = scopedFeedbackPath('usage', input.scope);
  if (
    receiptId &&
    readJsonLines<{ receipt_id?: string }>(usageLog, { onMalformed: 'skip' }).some(
      (record) => record.receipt_id === receiptId
    )
  ) {
    return { usageUpdated: false, promotionCandidateIds: [], usedRefs, receiptId };
  }
  const missingTopics = normalizeTopicList(feedback.missing_topics);
  const now = nowIso();

  let usageUpdated = false;
  let receiptRecorded = false;
  try {
    safeMkdir(path.dirname(usageLog), { recursive: true });
    ensureRegularFeedbackFile(usageLog);
    appendJsonLine(usageLog, {
      receipt_id: receiptId,
      mission_id: input.missionId,
      task_id: input.taskId,
      scope_context: input.scope,
      recorded_at: now,
      evidence: 'worker_report',
      outcome: input.outcome || 'incomplete',
      used: usedRefs,
      not_used: delivered.filter((ref) => notUsed.includes(ref.path)),
      rejected_paths: [
        ...normalizeTopicList(feedback.used),
        ...normalizeTopicList(feedback.not_used),
      ].filter((path) => !allowedPaths.has(path)),
      missing_topics: missingTopics,
    });
    receiptRecorded = true;
    if (receiptId)
      recordKnowledgeReuseObservation({
        documentSnapshots: usedRefs,
        receiptId,
        kind: input.outcome || 'incomplete',
        scope: input.scope,
        at: now,
      });
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
                // Preserve the observed source; sensitivityTier describes the destination.
                ...input.scope,
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

  return {
    usageUpdated,
    promotionCandidateIds,
    usedRefs: receiptRecorded ? usedRefs : [],
    ...(receiptRecorded && receiptId ? { receiptId } : {}),
  };
}

export function loadKnowledgeUsageAggregate(
  scope?: MemoryScopeEnvelope
): KnowledgeUsageAggregateEntry[] {
  return loadUsageAggregate(scope);
}
