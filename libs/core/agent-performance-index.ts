import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';

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

const OUTCOMES_PATH = 'observability/retrospectives/agent-role-outcomes.jsonl';
const INDEX_PATH = 'observability/retrospectives/agent-performance.json';

export function agentRoleOutcomesPath(): string {
  return pathResolver.shared(OUTCOMES_PATH);
}

export function agentPerformanceIndexPath(): string {
  return pathResolver.shared(INDEX_PATH);
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

/** Append this mission's outcomes and rebuild the aggregate index. */
export function recordAgentRoleOutcomes(outcomes: AgentRoleOutcome[]): void {
  if (outcomes.length === 0) return;
  const outcomesPath = agentRoleOutcomesPath();
  safeMkdir(path.dirname(outcomesPath), { recursive: true });
  safeAppendFileSync(
    outcomesPath,
    outcomes.map((outcome) => JSON.stringify(outcome)).join('\n') + '\n'
  );
  rebuildAgentPerformanceIndex();
}

export function rebuildAgentPerformanceIndex(): Record<string, AgentRolePerformance> {
  const outcomesPath = agentRoleOutcomesPath();
  const byKey: Record<string, AgentRolePerformance> = {};
  if (safeExistsSync(outcomesPath)) {
    const lines = String(safeReadFile(outcomesPath, { encoding: 'utf8' }))
      .split('\n')
      .filter((line) => line.trim());
    for (const line of lines) {
      let outcome: AgentRoleOutcome;
      try {
        outcome = JSON.parse(line) as AgentRoleOutcome;
      } catch {
        continue;
      }
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

export function getAgentRolePerformance(
  agentId: string,
  teamRole: string
): AgentRolePerformance | null {
  const now = Date.now();
  if (!cachedIndex || now - cachedIndex.loadedAt > INDEX_CACHE_TTL_MS) {
    let byKey: Record<string, AgentRolePerformance> = {};
    try {
      const indexPath = agentPerformanceIndexPath();
      if (safeExistsSync(indexPath)) {
        byKey =
          (
            JSON.parse(String(safeReadFile(indexPath, { encoding: 'utf8' }))) as {
              by_agent_role?: Record<string, AgentRolePerformance>;
            }
          ).by_agent_role || {};
      }
    } catch {
      byKey = {};
    }
    cachedIndex = { loadedAt: now, byKey };
  }
  return cachedIndex.byKey[keyFor(agentId, teamRole)] || null;
}

export function resetAgentPerformanceIndexCache(): void {
  cachedIndex = null;
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
