/**
 * Tandem-style mission blueprint validation (ported from
 * tandem/crates/tandem-workflows/src/mission_builder.rs):
 * collect-all ValidationMessage[] with stable codes instead of
 * throw-on-first-error, including dependency cycle detection on
 * NEXT_TASKS-style task lists.
 */

export type MissionValidationSeverity = 'error' | 'warning';

export interface MissionValidationMessage {
  severity: MissionValidationSeverity;
  code: string;
  message: string;
  subject_id?: string;
}

/**
 * Statuses a NEXT_TASKS board may legitimately carry: the Tandem port's core
 * vocabulary plus Kyberion's own lifecycle statuses
 * (`requested`/`rework`/`reviewed`/`accepted`/`done`/`dispatched` — see
 * PLANNED_NEXT_TASK_STATUS_PRIORITY and the dispatch/recovery writers).
 * Unknown statuses still report MISSION_TASK_STATUS_INVALID; a blocking
 * preflight consumer must not false-positive on a real board.
 */
const KNOWN_TASK_STATUSES: ReadonlySet<string> = new Set([
  'planned',
  'ready',
  'requested',
  'dispatched',
  'in_progress',
  'blocked',
  'waiting_review',
  'reviewed',
  'accepted',
  'rework',
  'completed',
  'done',
  'satisfied',
  'recorded',
  'skipped',
  'superseded',
  'failed',
  'cancelled',
]);

function error(code: string, message: string, subjectId?: string): MissionValidationMessage {
  return { severity: 'error', code, message, ...(subjectId ? { subject_id: subjectId } : {}) };
}

function warning(code: string, message: string, subjectId?: string): MissionValidationMessage {
  return { severity: 'warning', code, message, ...(subjectId ? { subject_id: subjectId } : {}) };
}

function dependencyList(task: Record<string, unknown>): string[] {
  return Array.isArray(task.dependencies)
    ? task.dependencies.map((d) => String(d || '').trim()).filter(Boolean)
    : [];
}

function detectCycle(adjacency: Map<string, string[]>): { start: string; path: string[] } | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string): { start: string; path: string[] } | null => {
    if (visited.has(node)) return null;
    if (visiting.has(node)) {
      const idx = stack.indexOf(node);
      return { start: node, path: [...stack.slice(idx), node] };
    }
    visiting.add(node);
    stack.push(node);
    for (const dep of adjacency.get(node) || []) {
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  };

  for (const node of adjacency.keys()) {
    const found = visit(node);
    if (found) return found;
  }
  return null;
}

export function validateMissionBlueprint(rawTasks: unknown): MissionValidationMessage[] {
  const messages: MissionValidationMessage[] = [];
  if (!Array.isArray(rawTasks)) {
    messages.push(error('MISSION_TASKS_NOT_ARRAY', 'NEXT_TASKS payload must be an array'));
    return messages;
  }

  const ids = new Set<string>();
  const adjacency = new Map<string, string[]>();
  const idList: string[] = [];

  rawTasks.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      messages.push(
        error('MISSION_TASK_NOT_OBJECT', `task ${index + 1} is not an object`, `index:${index}`)
      );
      return;
    }
    const task = entry as Record<string, unknown>;
    const taskId = String(task.task_id || '').trim();
    const status = String(task.status || 'planned').toLowerCase();
    if (task.status !== undefined && !KNOWN_TASK_STATUSES.has(status)) {
      messages.push(
        error(
          'MISSION_TASK_STATUS_INVALID',
          `task ${taskId || index + 1} has unknown status '${status}'`,
          taskId || `index:${index}`
        )
      );
    }
    if (!taskId) {
      messages.push(
        error('MISSION_TASK_ID_REQUIRED', `task ${index + 1} is missing task_id`, `index:${index}`)
      );
      return;
    }
    if (ids.has(taskId)) {
      messages.push(error('MISSION_TASK_ID_DUPLICATE', `duplicate task_id ${taskId}`, taskId));
    } else {
      ids.add(taskId);
      idList.push(taskId);
      adjacency.set(taskId, dependencyList(task));
    }

    const deliverable = String(task.deliverable || '').trim();
    if (!deliverable) {
      messages.push(
        warning('MISSION_DELIVERABLE_MISSING', `task ${taskId} has no deliverable path`, taskId)
      );
    }
    if (task.acceptance_criteria === undefined || task.acceptance_criteria === null) {
      messages.push(
        warning('MISSION_ACCEPTANCE_MISSING', `task ${taskId} has no acceptance_criteria`, taskId)
      );
    }
  });

  // Missing dependency references (Tandem: missing phase/milestone ids).
  for (const taskId of idList) {
    for (const dep of adjacency.get(taskId) || []) {
      if (!ids.has(dep)) {
        messages.push(
          error(
            'MISSION_DEPENDENCY_MISSING',
            `task ${taskId} depends on unknown task ${dep}`,
            taskId
          )
        );
      }
    }
  }

  // Cycle detection (Tandem validate_cycles: DFS with visiting/visited sets).
  const knownOnly = new Map<string, string[]>();
  for (const [taskId, deps] of adjacency) {
    knownOnly.set(
      taskId,
      deps.filter((d) => ids.has(d))
    );
  }
  const cycle = detectCycle(knownOnly);
  if (cycle) {
    messages.push(
      error(
        'MISSION_DEPENDENCY_CYCLE',
        `dependency cycle detected: ${cycle.path.join(' -> ')}`,
        cycle.start
      )
    );
  }

  return messages;
}

export function missionBlueprintHasErrors(messages: MissionValidationMessage[]): boolean {
  return messages.some((m) => m.severity === 'error');
}
