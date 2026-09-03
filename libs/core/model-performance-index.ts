import { appendJsonLine, parseSafeJsonObjectValue, readJsonLines } from './foundation/json.js';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from './secure-io.js';
import { nowIso } from './foundation/time.js';

/**
 * Model×role performance feedback used by future team staffing.
 *
 * Objective outcomes come from mission retrospectives. Explicit ratings are
 * operator/user observations and are intentionally kept separate in the
 * journal so either source can be audited and weighted independently.
 */

export interface ModelRoleOutcome {
  mission_id: string;
  task_id: string;
  team_role: string;
  provider?: string;
  model_id: string;
  final_status: string;
  recorded_at: string;
}

export interface ModelRoleFeedback {
  feedback_id: string;
  model_id: string;
  team_role: string;
  rating: 1 | 2 | 3 | 4 | 5;
  mission_id?: string;
  task_id?: string;
  comment?: string;
  source: 'user' | 'operator';
  recorded_at: string;
}

export interface ModelRolePerformance {
  samples: number;
  success: number;
  review: number;
  blocked: number;
  success_rate: number;
  feedback_samples: number;
  average_rating: number;
}

export interface ModelPerformanceIndex {
  by_model_role: Record<string, ModelRolePerformance>;
}

const OUTCOMES_PATH = 'observability/retrospectives/model-role-outcomes.jsonl';
const FEEDBACK_PATH = 'observability/retrospectives/model-role-feedback.jsonl';
const INDEX_PATH = 'observability/retrospectives/model-performance.json';
const INDEX_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/model-performance-index.schema.json'
);
const OUTCOME_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/model-role-outcome.schema.json'
);
const FEEDBACK_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/model-role-feedback.schema.json'
);

function performanceIndexCatalog(filePath: string) {
  return defineCatalog<ModelPerformanceIndex>({
    id: 'model-performance-index',
    path: filePath,
    schema: INDEX_SCHEMA_PATH,
  });
}

function modelRoleOutcomeCatalog(filePath: string): GovernedCatalog<ModelRoleOutcome> {
  return defineCatalog<ModelRoleOutcome>({
    id: 'model-role-outcome',
    path: filePath,
    schema: OUTCOME_SCHEMA_PATH,
  });
}

function modelRoleFeedbackCatalog(filePath: string): GovernedCatalog<ModelRoleFeedback> {
  return defineCatalog<ModelRoleFeedback>({
    id: 'model-role-feedback',
    path: filePath,
    schema: FEEDBACK_SCHEMA_PATH,
  });
}

export const MODEL_PERFORMANCE_MIN_SAMPLES = 5;
const MAX_MODEL_ID_LENGTH = 160;
const MAX_TEAM_ROLE_LENGTH = 80;
const MAX_REFERENCE_LENGTH = 160;
const MAX_COMMENT_LENGTH = 2_000;

export function modelRoleOutcomesPath(): string {
  return assertSafeRepositoryPath(pathResolver.shared(OUTCOMES_PATH), { allowMissingLeaf: true });
}

export function modelRoleFeedbackPath(): string {
  return assertSafeRepositoryPath(pathResolver.shared(FEEDBACK_PATH), { allowMissingLeaf: true });
}

export function modelPerformanceIndexPath(): string {
  return assertSafeRepositoryPath(pathResolver.shared(INDEX_PATH), { allowMissingLeaf: true });
}

function keyFor(modelId: string, teamRole: string): string {
  return `${modelId.toLowerCase()}|${teamRole.toLowerCase()}`;
}

function outcomeKey(
  outcome: Pick<ModelRoleOutcome, 'mission_id' | 'task_id' | 'team_role' | 'model_id'>
): string {
  return [outcome.mission_id, outcome.task_id, outcome.team_role, outcome.model_id]
    .map((value) =>
      String(value || '')
        .trim()
        .toLowerCase()
    )
    .join('|');
}

function scoreStatus(status: string): { success: number; review: number; blocked: number } {
  const normalized = status.toLowerCase();
  if (['done', 'completed', 'accepted'].includes(normalized)) {
    return { success: 1, review: 0, blocked: 0 };
  }
  if (['review', 'reviewed'].includes(normalized)) {
    return { success: 0, review: 1, blocked: 0 };
  }
  return { success: 0, review: 0, blocked: 1 };
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const expectedKeys = new Set(expected);
  const unknown = Object.keys(record).filter((key) => !expectedKeys.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown field(s): ${unknown.join(', ')}`);
  }
}

function parsePerformanceRecord(value: unknown, label: string): ModelRolePerformance {
  const record = parseSafeJsonObjectValue(value, label);
  assertExactKeys(
    record,
    [
      'samples',
      'success',
      'review',
      'blocked',
      'success_rate',
      'feedback_samples',
      'average_rating',
    ],
    label
  );
  const counters = ['samples', 'success', 'review', 'blocked', 'feedback_samples'] as const;
  for (const field of counters) {
    const count = record[field];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${label}.${field} must be a non-negative integer`);
    }
  }
  const successRate = record.success_rate;
  if (
    typeof successRate !== 'number' ||
    !Number.isFinite(successRate) ||
    successRate < 0 ||
    successRate > 1
  ) {
    throw new Error(`${label}.success_rate must be a number between 0 and 1`);
  }
  const averageRating = record.average_rating;
  if (
    typeof averageRating !== 'number' ||
    !Number.isFinite(averageRating) ||
    averageRating < 0 ||
    averageRating > 5
  ) {
    throw new Error(`${label}.average_rating must be a number between 0 and 5`);
  }
  return {
    samples: record.samples as number,
    success: record.success as number,
    review: record.review as number,
    blocked: record.blocked as number,
    success_rate: successRate,
    feedback_samples: record.feedback_samples as number,
    average_rating: averageRating,
  };
}

/** Parse the persisted model x role performance projection before routing uses it. */
export function parseModelPerformanceIndex(value: unknown): ModelPerformanceIndex {
  const root = parseSafeJsonObjectValue(value, 'model performance index');
  assertExactKeys(root, ['by_model_role'], 'model performance index');
  const byModelRole = parseSafeJsonObjectValue(
    root.by_model_role,
    'model performance index.by_model_role'
  );
  const parsed: Record<string, ModelRolePerformance> = {};
  for (const [key, valueForKey] of Object.entries(byModelRole)) {
    if (!key.trim() || !key.includes('|')) {
      throw new Error(`model performance index.by_model_role key must be "model|role": ${key}`);
    }
    parsed[key] = parsePerformanceRecord(
      valueForKey,
      `model performance index.by_model_role.${key}`
    );
  }
  return { by_model_role: parsed };
}

function readJsonl<T>(filePath: string, catalog: GovernedCatalog<T>): T[] {
  if (!safeExistsSync(filePath)) return [];
  if (!safeLstat(filePath).isFile()) {
    throw new Error(`[MODEL_PERFORMANCE] record log must be a regular file: ${filePath}`);
  }
  return readJsonLines<T>(filePath, {
    onMalformed: 'skip',
    map: (value, lineNumber) => catalog.validate(value, `${filePath}:${lineNumber}`),
  });
}

function appendJsonl<T>(filePath: string, records: T[], catalog: GovernedCatalog<T>): void {
  if (records.length === 0) return;
  safeMkdir(path.dirname(filePath), { recursive: true });
  if (safeExistsSync(filePath) && !safeLstat(filePath).isFile()) {
    throw new Error(`[MODEL_PERFORMANCE] record log must be a regular file: ${filePath}`);
  }
  for (const record of records) appendJsonLine(filePath, catalog.validate(record, filePath));
}

export function recordModelRoleOutcomes(outcomes: ModelRoleOutcome[]): void {
  const valid = outcomes.filter((outcome) => outcome.model_id?.trim() && outcome.team_role?.trim());
  if (valid.length === 0) return;
  const outcomesPath = modelRoleOutcomesPath();
  const catalog = modelRoleOutcomeCatalog(outcomesPath);
  const validated = valid.map((outcome) => catalog.validate(outcome, outcomesPath));
  const existing = readJsonl<ModelRoleOutcome>(outcomesPath, catalog);
  const latestByOutcome = new Map(existing.map((outcome) => [outcomeKey(outcome), outcome]));
  const append = validated.filter((outcome) => {
    const key = outcomeKey(outcome);
    const previous = latestByOutcome.get(key);
    latestByOutcome.set(key, outcome);
    return (
      !previous ||
      previous.final_status !== outcome.final_status ||
      previous.provider !== outcome.provider
    );
  });
  appendJsonl(outcomesPath, append, catalog);
  if (validated.length > 0) rebuildModelPerformanceIndex();
}

export function recordModelRoleFeedback(input: {
  modelId: string;
  teamRole: string;
  rating: number;
  missionId?: string;
  taskId?: string;
  comment?: string;
  source?: 'user' | 'operator';
}): ModelRoleFeedback {
  const modelId = input.modelId.trim();
  const teamRole = input.teamRole.trim();
  if (!modelId) throw new Error('modelId is required');
  if (modelId.length > MAX_MODEL_ID_LENGTH) throw new Error('modelId is too long');
  if (!teamRole) throw new Error('teamRole is required');
  if (teamRole.length > MAX_TEAM_ROLE_LENGTH) throw new Error('teamRole is too long');
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    throw new Error('rating must be an integer from 1 to 5');
  }
  if (input.missionId && input.missionId.trim().length > MAX_REFERENCE_LENGTH) {
    throw new Error('missionId is too long');
  }
  if (input.taskId && input.taskId.trim().length > MAX_REFERENCE_LENGTH) {
    throw new Error('taskId is too long');
  }
  if (input.comment && input.comment.trim().length > MAX_COMMENT_LENGTH) {
    throw new Error('comment is too long');
  }
  if (input.source !== undefined && input.source !== 'user' && input.source !== 'operator') {
    throw new Error('source must be user or operator');
  }
  const feedback: ModelRoleFeedback = {
    feedback_id: `MFB-${randomUUID().slice(0, 8).toUpperCase()}`,
    model_id: modelId,
    team_role: teamRole,
    rating: input.rating as ModelRoleFeedback['rating'],
    ...(input.missionId?.trim() ? { mission_id: input.missionId.trim() } : {}),
    ...(input.taskId?.trim() ? { task_id: input.taskId.trim() } : {}),
    ...(input.comment?.trim() ? { comment: input.comment.trim() } : {}),
    source: input.source || 'user',
    recorded_at: nowIso(),
  };
  const feedbackPath = modelRoleFeedbackPath();
  appendJsonl(feedbackPath, [feedback], modelRoleFeedbackCatalog(feedbackPath));
  rebuildModelPerformanceIndex();
  return feedback;
}

export function rebuildModelPerformanceIndex(): Record<string, ModelRolePerformance> {
  const byKey: Record<string, ModelRolePerformance> = {};
  const latestOutcomes = new Map<string, ModelRoleOutcome>();
  const outcomesPath = modelRoleOutcomesPath();
  for (const outcome of readJsonl<ModelRoleOutcome>(
    outcomesPath,
    modelRoleOutcomeCatalog(outcomesPath)
  )) {
    if (!outcome.model_id || !outcome.team_role) continue;
    latestOutcomes.set(outcomeKey(outcome), outcome);
  }
  for (const outcome of latestOutcomes.values()) {
    if (!outcome.model_id || !outcome.team_role) continue;
    const bucket = (byKey[keyFor(outcome.model_id, outcome.team_role)] ||= {
      samples: 0,
      success: 0,
      review: 0,
      blocked: 0,
      success_rate: 0,
      feedback_samples: 0,
      average_rating: 0,
    });
    const scored = scoreStatus(String(outcome.final_status || ''));
    bucket.samples += 1;
    bucket.success += scored.success;
    bucket.review += scored.review;
    bucket.blocked += scored.blocked;
  }

  const feedbackPath = modelRoleFeedbackPath();
  for (const feedback of readJsonl<ModelRoleFeedback>(
    feedbackPath,
    modelRoleFeedbackCatalog(feedbackPath)
  )) {
    if (!feedback.model_id || !feedback.team_role) continue;
    const bucket = (byKey[keyFor(feedback.model_id, feedback.team_role)] ||= {
      samples: 0,
      success: 0,
      review: 0,
      blocked: 0,
      success_rate: 0,
      feedback_samples: 0,
      average_rating: 0,
    });
    bucket.feedback_samples += 1;
    bucket.average_rating += feedback.rating;
  }

  for (const bucket of Object.values(byKey)) {
    bucket.success_rate =
      bucket.samples > 0 ? (bucket.success + bucket.review * 0.5) / bucket.samples : 0;
    if (bucket.feedback_samples > 0) {
      bucket.average_rating /= bucket.feedback_samples;
    }
  }

  const indexPath = modelPerformanceIndexPath();
  safeMkdir(path.dirname(indexPath), { recursive: true });
  const validated = performanceIndexCatalog(indexPath).validate(
    { by_model_role: byKey },
    indexPath
  );
  safeWriteFile(indexPath, JSON.stringify(validated, null, 2));
  return byKey;
}

let cachedIndex: { loadedAt: number; byKey: Record<string, ModelRolePerformance> } | null = null;
const INDEX_CACHE_TTL_MS = 30_000;

export function resetModelPerformanceIndexCache(): void {
  cachedIndex = null;
}

/** Load every validated model x role performance bucket for read-only consumers. */
export function loadModelPerformanceIndex(): Record<string, ModelRolePerformance> {
  const indexPath = modelPerformanceIndexPath();
  if (!safeExistsSync(indexPath)) return {};
  return loadModelPerformanceIndexAtPath(indexPath).by_model_role;
}

/** Load a model performance projection through the governed catalog boundary. */
export function loadModelPerformanceIndexAtPath(filePath: string): ModelPerformanceIndex {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[MODEL_PERFORMANCE] index must be a regular file: ${filePath}`);
  }
  const indexed = performanceIndexCatalog(safeFilePath).load();
  return parseModelPerformanceIndex(indexed);
}

export function getModelRolePerformance(
  modelId: string,
  teamRole: string
): ModelRolePerformance | null {
  const now = Date.now();
  if (!cachedIndex || now - cachedIndex.loadedAt > INDEX_CACHE_TTL_MS) {
    let byKey: Record<string, ModelRolePerformance> = {};
    try {
      byKey = loadModelPerformanceIndex();
    } catch {
      byKey = {};
    }
    cachedIndex = { loadedAt: now, byKey };
  }
  return cachedIndex.byKey[keyFor(modelId, teamRole)] || null;
}

/**
 * Keep learned preference bounded and silent until there is enough evidence.
 * Explicit role/model preferences still outweigh this small adjustment.
 */
export function modelPerformanceScoreAdjustment(modelId: string, teamRole: string): number {
  const performance = getModelRolePerformance(modelId, teamRole);
  if (!performance) return 0;
  const evidenceSamples = performance.samples + performance.feedback_samples;
  if (evidenceSamples < MODEL_PERFORMANCE_MIN_SAMPLES) return 0;
  const ratingScore =
    performance.feedback_samples > 0 ? performance.average_rating / 5 : performance.success_rate;
  const qualityScore =
    performance.samples > 0 ? performance.success_rate * 0.7 + ratingScore * 0.3 : ratingScore;
  return Math.round((qualityScore - 0.5) * 8);
}
