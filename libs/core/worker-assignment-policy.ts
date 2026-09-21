import { loadWorkforceCapacityPolicy, type WorkforceLoadSnapshot } from './workforce-load.js';

/**
 * TC-09: the single place that decides what being busy costs a candidate.
 *
 * This module already scored lease count, in-flight task count and scope
 * conflicts, but nothing called it — team composition scored load not at all,
 * so the repository carried two answers to the same question, one of them
 * dead. It is now the shared implementation: `recommendWorkerAssignments`
 * uses it per task, and `selectAgentForTeamRole` uses it per candidate, both
 * reading the governed thresholds in `workforce-capacity-policy.json`.
 */
export function workerLoadPenalty(load: {
  active_work_items?: number;
  queued_work_items?: number;
  status?: WorkforceLoadSnapshot['status'];
}): number {
  const policy = loadWorkforceCapacityPolicy().selection;
  const active = Math.max(0, Number(load.active_work_items || 0));
  const queued = Math.max(0, Number(load.queued_work_items || 0));
  const penalty =
    active * policy.load_penalty_per_active_item +
    queued * policy.queued_penalty_per_item +
    (load.status === 'saturated' ? policy.saturated_penalty : 0);
  const ceiling = policy.max_load_penalty;
  return typeof ceiling === 'number' ? Math.min(penalty, ceiling) : penalty;
}

export type WorkerAssignmentMode =
  'direct_specialist' | 'lease_aware_capability' | 'dependency_first';

export interface WorkerCapabilityProfile {
  agent_id: string;
  team_roles: string[];
  capabilities: string[];
  active_lease_count?: number;
  current_task_count?: number;
  leased_scopes?: string[];
}

export interface WorkerAssignableTask {
  task_id: string;
  title: string;
  required_capabilities?: string[];
  preferred_team_role?: string;
  blocked_dependents?: number;
  scope?: string;
}

export interface WorkerAssignmentDecision {
  task_id: string;
  agent_id: string | null;
  policy: WorkerAssignmentMode;
  score: number;
  rationale: string[];
}

function normalizeSet(values?: string[]): string[] {
  return Array.isArray(values) ? values.map((value) => String(value).trim()).filter(Boolean) : [];
}

function overlapsScope(scope: string | undefined, leasedScopes: string[]): boolean {
  if (!scope) return false;
  return leasedScopes.some((leased) => leased === scope);
}

function scoreWorker(
  task: WorkerAssignableTask,
  worker: WorkerCapabilityProfile,
  policy: WorkerAssignmentMode
): WorkerAssignmentDecision {
  const requiredCapabilities = normalizeSet(task.required_capabilities);
  const workerCapabilities = normalizeSet(worker.capabilities);
  const teamRoles = normalizeSet(worker.team_roles);
  const leasedScopes = normalizeSet(worker.leased_scopes);
  const rationale: string[] = [];
  let score = 0;

  const capabilityHits = requiredCapabilities.filter((capability) =>
    workerCapabilities.includes(capability)
  );
  if (capabilityHits.length > 0) {
    score += capabilityHits.length * 10;
    rationale.push(`matched capabilities: ${capabilityHits.join(', ')}`);
  }

  if (task.preferred_team_role && teamRoles.includes(task.preferred_team_role)) {
    score += 8;
    rationale.push(`matched preferred role: ${task.preferred_team_role}`);
  }

  const activeLeaseCount = Math.max(0, Number(worker.active_lease_count || 0));
  const currentTaskCount = Math.max(0, Number(worker.current_task_count || 0));
  const loadPenalty = workerLoadPenalty({
    active_work_items: currentTaskCount,
    queued_work_items: activeLeaseCount,
  });
  score -= loadPenalty;
  if (loadPenalty > 0) {
    rationale.push(
      `penalized load: ${currentTaskCount} active task(s), ${activeLeaseCount} lease(s) (-${loadPenalty})`
    );
  }

  if (overlapsScope(task.scope, leasedScopes)) {
    score -= 100;
    rationale.push(`scope conflict: ${task.scope}`);
  }

  if (policy === 'dependency_first') {
    const blockedDependents = Math.max(0, Number(task.blocked_dependents || 0));
    if (blockedDependents > 0) {
      score += blockedDependents * 2;
      rationale.push(`prioritized unblock count: ${blockedDependents}`);
    }
  }

  if (
    policy === 'direct_specialist' &&
    requiredCapabilities.length === 0 &&
    task.preferred_team_role &&
    teamRoles.includes(task.preferred_team_role)
  ) {
    score += 5;
  }

  return {
    task_id: task.task_id,
    agent_id: worker.agent_id,
    policy,
    score,
    rationale,
  };
}

export function recommendWorkerAssignments(input: {
  tasks: WorkerAssignableTask[];
  workers: WorkerCapabilityProfile[];
  policy?: WorkerAssignmentMode;
}): WorkerAssignmentDecision[] {
  const policy = input.policy || 'lease_aware_capability';
  const workers = Array.isArray(input.workers) ? input.workers : [];
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];

  return tasks.map((task) => {
    if (workers.length === 0) {
      return {
        task_id: task.task_id,
        agent_id: null,
        policy,
        score: -1,
        rationale: ['no workers available'],
      } satisfies WorkerAssignmentDecision;
    }

    const ranked = workers
      .map((worker) => scoreWorker(task, worker, policy))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return String(left.agent_id || '').localeCompare(String(right.agent_id || ''));
      });

    const winner = ranked[0]!;
    return winner.score < 0
      ? {
          ...winner,
          agent_id: null,
          rationale: [...winner.rationale, 'no worker satisfied the assignment threshold'],
        }
      : winner;
  });
}
