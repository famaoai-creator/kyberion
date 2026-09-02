import {
  appendJsonLine,
  parseSafeJsonObjectValue,
  readJson,
  readJsonLines,
} from './foundation/json.js';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';

/**
 * Agent×role performance index — the deterministic data path from mission
 * retrospectives back into team composition. Kept dependency-light on purpose
 * (path-resolver + secure-io only) so the team-role selection scorer can read
 * it without dragging in the reasoning/notification stack.
 *
 * Semantics: `success` = the work item reached done/completed/accepted.
 * `review` counts as neutral progress (0.5) — the work shipped but needed a
 * gate; `blocked` counts as failure.
 */

export interface AgentRoleOutcome {
  mission_id: string;
  task_id: string;
  team_role: string;
  assignee: string;
  final_status: string;
  recorded_at: string;
}

export interface AgentRolePerformance {
  samples: number;
  success: number;
  review: number;
  blocked: number;
  success_rate: number;
}

export interface AgentPerformanceIndex {
  by_agent_role: Record<string, AgentRolePerformance>;
}

const OUTCOMES_PATH = 'observability/retrospectives/agent-role-outcomes.jsonl';
const INDEX_PATH = 'observability/retrospectives/agent-performance.json';

export function agentRoleOutcomesPath(): string {
  return assertSafeRepositoryPath(pathResolver.shared(OUTCOMES_PATH), { allowMissingLeaf: true });
}

export function agentPerformanceIndexPath(): string {
  return assertSafeRepositoryPath(pathResolver.shared(INDEX_PATH), { allowMissingLeaf: true });
}

function keyFor(agentId: string, teamRole: string): string {
  return `${agentId.toLowerCase()}|${teamRole.toLowerCase()}`;
}

function scoreStatus(status: string): { success: number; review: number; blocked: number } {
  const normalized = status.toLowerCase();
  if (['done', 'completed', 'accepted'].includes(normalized)) {
    return { success: 1, review: 0, blocked: 0 };
  }
  if (normalized === 'review' || normalized === 'reviewed') {
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

function parsePerformanceRecord(value: unknown, label: string): AgentRolePerformance {
  const record = parseSafeJsonObjectValue(value, label);
  assertExactKeys(record, ['samples', 'success', 'review', 'blocked', 'success_rate'], label);
  const counters = ['samples', 'success', 'review', 'blocked'] as const;
  for (const field of counters) {
    const count = record[field];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${label}.${field} must be a non-negative integer`);
    }
  }
  const samples = record.samples as number;
  const success = record.success as number;
  const review = record.review as number;
  const blocked = record.blocked as number;
  const successRate = record.success_rate;
  if (
    typeof successRate !== 'number' ||
    !Number.isFinite(successRate) ||
    successRate < 0 ||
    successRate > 1
  ) {
    throw new Error(`${label}.success_rate must be a number between 0 and 1`);
  }
  return {
    samples,
    success,
    review,
    blocked,
    success_rate: successRate,
  };
}

/** Parse the persisted agent x role performance projection before consumers use it. */
export function parseAgentPerformanceIndex(value: unknown): AgentPerformanceIndex {
  const root = parseSafeJsonObjectValue(value, 'agent performance index');
  assertExactKeys(root, ['by_agent_role'], 'agent performance index');
  const byAgentRole = parseSafeJsonObjectValue(
    root.by_agent_role,
    'agent performance index.by_agent_role'
  );
  const parsed: Record<string, AgentRolePerformance> = {};
  for (const [key, valueForKey] of Object.entries(byAgentRole)) {
    if (!key.trim() || !key.includes('|')) {
      throw new Error(`agent performance index.by_agent_role key must be "agent|role": ${key}`);
    }
    parsed[key] = parsePerformanceRecord(
      valueForKey,
      `agent performance index.by_agent_role.${key}`
    );
  }
  return { by_agent_role: parsed };
}

/** Append this mission's outcomes and rebuild the aggregate index. */
export function recordAgentRoleOutcomes(outcomes: AgentRoleOutcome[]): void {
  if (outcomes.length === 0) return;
  const outcomesPath = agentRoleOutcomesPath();
  safeMkdir(path.dirname(outcomesPath), { recursive: true });
  for (const outcome of outcomes) appendJsonLine(outcomesPath, outcome);
  rebuildAgentPerformanceIndex();
}

export function rebuildAgentPerformanceIndex(): Record<string, AgentRolePerformance> {
  const outcomesPath = agentRoleOutcomesPath();
  const byKey: Record<string, AgentRolePerformance> = {};
  if (safeExistsSync(outcomesPath)) {
    const outcomes = readJsonLines<AgentRoleOutcome | null>(outcomesPath, {
      onMalformed: 'skip',
      map: (value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as AgentRoleOutcome)
          : null,
    });
    for (const outcome of outcomes) {
      if (!outcome) continue;
      if (!outcome.assignee || !outcome.team_role) continue;
      const key = keyFor(outcome.assignee, outcome.team_role);
      const bucket = (byKey[key] ||= {
        samples: 0,
        success: 0,
        review: 0,
        blocked: 0,
        success_rate: 0,
      });
      const scored = scoreStatus(String(outcome.final_status || ''));
      bucket.samples += 1;
      bucket.success += scored.success;
      bucket.review += scored.review;
      bucket.blocked += scored.blocked;
    }
  }
  for (const bucket of Object.values(byKey)) {
    bucket.success_rate =
      bucket.samples > 0 ? (bucket.success + bucket.review * 0.5) / bucket.samples : 0;
  }
  const indexPath = agentPerformanceIndexPath();
  safeMkdir(path.dirname(indexPath), { recursive: true });
  safeWriteFile(indexPath, JSON.stringify({ by_agent_role: byKey }, null, 2));
  return byKey;
}

let cachedIndex: { loadedAt: number; byKey: Record<string, AgentRolePerformance> } | null = null;
const INDEX_CACHE_TTL_MS = 30_000;

export function resetAgentPerformanceIndexCache(): void {
  cachedIndex = null;
}

/** Load every validated agent x role performance bucket for read-only projections. */
export function loadAgentPerformanceIndex(): Record<string, AgentRolePerformance> {
  const indexPath = agentPerformanceIndexPath();
  if (!safeExistsSync(indexPath)) return {};
  return parseAgentPerformanceIndex(readJson<unknown>(indexPath)).by_agent_role;
}

export function getAgentRolePerformance(
  agentId: string,
  teamRole: string
): AgentRolePerformance | null {
  const now = Date.now();
  if (!cachedIndex || now - cachedIndex.loadedAt > INDEX_CACHE_TTL_MS) {
    let byKey: Record<string, AgentRolePerformance> = {};
    try {
      byKey = loadAgentPerformanceIndex();
    } catch {
      byKey = {};
    }
    cachedIndex = { loadedAt: now, byKey };
  }
  return cachedIndex.byKey[keyFor(agentId, teamRole)] || null;
}

/**
 * Score adjustment for team-role selection: proven performers get a bounded
 * bonus, repeat underperformers a bounded penalty. Silent (0) below the
 * minimum sample size so a single bad day cannot reshape the team.
 */
export const PERFORMANCE_MIN_SAMPLES = 5;

export function performanceScoreAdjustment(agentId: string, teamRole: string): number {
  const performance = getAgentRolePerformance(agentId, teamRole);
  if (!performance || performance.samples < PERFORMANCE_MIN_SAMPLES) return 0;
  // success_rate 1.0 → +8, 0.5 → 0, 0.0 → -8 (below preferred_agents=20 so
  // explicit operator preference always wins).
  return Math.round((performance.success_rate - 0.5) * 16);
}
