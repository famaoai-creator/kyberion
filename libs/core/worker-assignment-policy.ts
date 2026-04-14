export type WorkerAssignmentMode =
  | 'direct_specialist'
  | 'lease_aware_capability'
  | 'dependency_first';

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
  return Array.isArray(values)
    ? values.map((value) => String(value).trim()).filter(Boolean)
    : [];
}

function overlapsScope(scope: string | undefined, leasedScopes: string[]): boolean {
  if (!scope) return false;
  return leasedScopes.some((leased) => leased === scope);
}

function scoreWorker(task: WorkerAssignableTask, worker: WorkerCapabilityProfile, policy: WorkerAssignmentMode): WorkerAssignmentDecision {
  const requiredCapabilities = normalizeSet(task.required_capabilities);
  const workerCapabilities = normalizeSet(worker.capabilities);
  const teamRoles = normalizeSet(worker.team_roles);
  const leasedScopes = normalizeSet(worker.leased_scopes);
  const rationale: string[] = [];
  let score = 0;

  const capabilityHits = requiredCapabilities.filter((capability) => workerCapabilities.includes(capability));
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
  score -= activeLeaseCount * 3;
  score -= currentTaskCount * 2;
  if (activeLeaseCount > 0) {
    rationale.push(`penalized active leases: ${activeLeaseCount}`);
  }
  if (currentTaskCount > 0) {
    rationale.push(`penalized active tasks: ${currentTaskCount}`);
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

  if (policy === 'direct_specialist' && requiredCapabilities.length === 0 && task.preferred_team_role && teamRoles.includes(task.preferred_team_role)) {
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
