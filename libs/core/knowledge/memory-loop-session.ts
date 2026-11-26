/**
 * Session-scoped memory-loop facade (CLI / MCP / interactive work).
 *
 * Bridges external interactive sessions (where work does not go through a full
 * mission context pack) into KP-05 / D8 memory-loop telemetry and IL-05
 * conversational correction capture:
 *   1. `recallPromotedKnowledgeForSession` — finds relevant promoted records
 *      and records a canonical `recordKnowledgeDelivery` receipt bound to
 *      `session:<sessionId>` + `scope`.
 *   2. `citePromotedKnowledgeForSession` — records `used` / `not_used` /
 *      `missing_topics` against that session's delivered refs via
 *      `recordKnowledgeUsageFeedback` (rejecting paths never delivered to the
 *      session).
 *   3. `captureSessionCorrection` — delegates to IL-05
 *      `captureConversationalCorrectionLearning` (fail-closed scope + secret/PII
 *      scrubbing before persistence).
 */
import {
  captureConversationalCorrectionLearning,
  type CaptureConversationalCorrectionResult,
} from './conversational-correction-learning.js';
import {
  recordKnowledgeDelivery,
  recordKnowledgeUsageFeedback,
} from './knowledge-feedback-loop.js';
import { assertMemoryScope, type MemoryScopeEnvelope } from './memory-scope.js';
import {
  findRelevantPromotedKnowledge,
  type PromotedKnowledgeEntry,
} from './promoted-knowledge-retrieval.js';

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_RECALL_LIMIT = 5;
const MAX_RECALL_LIMIT = 10;
const DEFAULT_RECALL_MIN_SCORE = 0.05;

export function assertValidMemoryLoopSessionId(sessionId: string): string {
  const normalized = String(sessionId ?? '').trim();
  if (!SESSION_ID_RE.test(normalized)) {
    throw new Error(`[MEMORY_LOOP_SESSION_INVALID] sessionId must match ${SESSION_ID_RE.source}`);
  }
  return normalized;
}

export function sessionMemoryMissionId(sessionId: string): string {
  return `session:${assertValidMemoryLoopSessionId(sessionId)}`;
}

function normalizeDistinctPaths(values: readonly string[] | undefined): string[] {
  if (!values?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export interface RecallPromotedKnowledgeForSessionInput {
  topic: string;
  sessionId: string;
  scope?: MemoryScopeEnvelope;
  limit?: number;
  minScore?: number;
  recipientKind?: 'cli_session' | 'mcp_session';
  rootDir?: string;
  /** Test seams. */
  findKnowledge?: typeof findRelevantPromotedKnowledge;
  recordDelivery?: typeof recordKnowledgeDelivery;
}

export interface RecallPromotedKnowledgeForSessionResult {
  session_id: string;
  mission_id: string;
  delivered_count: number;
  delivery_record_path?: string;
  entries: PromotedKnowledgeEntry[];
}

export async function recallPromotedKnowledgeForSession(
  input: RecallPromotedKnowledgeForSessionInput
): Promise<RecallPromotedKnowledgeForSessionResult> {
  const sessionId = assertValidMemoryLoopSessionId(input.sessionId);
  const missionId = sessionMemoryMissionId(sessionId);
  const topic = String(input.topic ?? '').trim();
  if (!topic) {
    throw new Error('[MEMORY_LOOP_TOPIC_REQUIRED] topic must be a non-empty string');
  }
  const canonicalScope = input.scope ? assertMemoryScope(input.scope) : undefined;
  const rawLimit =
    typeof input.limit === 'number' && Number.isFinite(input.limit)
      ? input.limit
      : DEFAULT_RECALL_LIMIT;
  const limit = Math.max(1, Math.min(MAX_RECALL_LIMIT, Math.floor(rawLimit)));
  const minScore =
    typeof input.minScore === 'number' && Number.isFinite(input.minScore)
      ? input.minScore
      : DEFAULT_RECALL_MIN_SCORE;

  const findKnowledge = input.findKnowledge ?? findRelevantPromotedKnowledge;
  const recordDelivery = input.recordDelivery ?? recordKnowledgeDelivery;

  const entries = await findKnowledge({
    topic,
    limit,
    minScore,
    ...(canonicalScope ? { scope: canonicalScope } : {}),
    ...(input.rootDir ? { rootDir: input.rootDir } : {}),
  });

  if (entries.length === 0) {
    return {
      session_id: sessionId,
      mission_id: missionId,
      delivered_count: 0,
      entries: [],
    };
  }

  const delivery = recordDelivery({
    missionId,
    taskId: sessionId,
    recipientKind: input.recipientKind ?? 'cli_session',
    ...(canonicalScope ? { scope: canonicalScope } : {}),
    refs: entries.map((entry) => ({
      path: entry.path,
      score: entry.score,
      title: entry.title,
    })),
  });

  return {
    session_id: sessionId,
    mission_id: missionId,
    delivered_count: entries.length,
    ...(delivery?.deliveryRecordPath ? { delivery_record_path: delivery.deliveryRecordPath } : {}),
    entries,
  };
}

export interface CitePromotedKnowledgeForSessionInput {
  sessionId: string;
  used: readonly string[];
  notUsed?: readonly string[];
  missingTopics?: readonly string[];
  scope?: MemoryScopeEnvelope;
  resultId?: string;
  /** Test seam. */
  recordUsage?: typeof recordKnowledgeUsageFeedback;
}

export interface CitePromotedKnowledgeForSessionResult {
  session_id: string;
  mission_id: string;
  usage_updated: boolean;
  used_paths: string[];
  rejected_used_paths: string[];
  promotion_candidate_ids: string[];
  receipt_id?: string;
}

export function citePromotedKnowledgeForSession(
  input: CitePromotedKnowledgeForSessionInput
): CitePromotedKnowledgeForSessionResult {
  const sessionId = assertValidMemoryLoopSessionId(input.sessionId);
  const missionId = sessionMemoryMissionId(sessionId);
  const canonicalScope = input.scope ? assertMemoryScope(input.scope) : undefined;
  const used = normalizeDistinctPaths(input.used);
  const notUsed = normalizeDistinctPaths(input.notUsed);
  const missingTopics = normalizeDistinctPaths(input.missingTopics);
  if (used.length === 0 && notUsed.length === 0 && missingTopics.length === 0) {
    throw new Error(
      '[MEMORY_LOOP_CITE_EMPTY] at least one used path, notUsed path, or missingTopic is required'
    );
  }

  const recordUsage = input.recordUsage ?? recordKnowledgeUsageFeedback;
  const feedbackResult = recordUsage({
    missionId,
    taskId: sessionId,
    ...(canonicalScope ? { scope: canonicalScope } : {}),
    ...(input.resultId?.trim() ? { resultId: input.resultId.trim() } : {}),
    outcome: 'worker_report_complete',
    feedback: {
      used,
      not_used: notUsed,
      missing_topics: missingTopics,
    },
  });

  const usedPaths = (feedbackResult.usedRefs ?? []).map((ref) => ref.path);
  const acceptedSet = new Set(usedPaths);
  const rejectedUsedPaths = used.filter((documentPath) => !acceptedSet.has(documentPath));

  return {
    session_id: sessionId,
    mission_id: missionId,
    usage_updated: feedbackResult.usageUpdated,
    used_paths: usedPaths,
    rejected_used_paths: rejectedUsedPaths,
    promotion_candidate_ids: feedbackResult.promotionCandidateIds,
    ...(feedbackResult.receiptId ? { receipt_id: feedbackResult.receiptId } : {}),
  };
}

export interface CaptureSessionCorrectionInput {
  text: string;
  sessionId: string;
  scope?: MemoryScopeEnvelope;
  surface?: string;
  locales?: readonly string[];
  /** Test seam. */
  captureFn?: typeof captureConversationalCorrectionLearning;
}

export function captureSessionCorrection(
  input: CaptureSessionCorrectionInput
): CaptureConversationalCorrectionResult {
  const sessionId = assertValidMemoryLoopSessionId(input.sessionId);
  const captureFn = input.captureFn ?? captureConversationalCorrectionLearning;
  return captureFn({
    text: input.text,
    scope: input.scope,
    correlationId: sessionId,
    surface: input.surface ?? 'cli',
    ...(input.locales ? { locales: input.locales } : {}),
  });
}
