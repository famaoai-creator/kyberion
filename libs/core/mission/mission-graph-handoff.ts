/**
 * Mission graph handoff contracts.
 *
 * The mission worker still owns assignment and provider dispatch. This module
 * only defines the deterministic data edge between a completed task node and
 * its dependency successors, so a successor can consume the predecessor's
 * result without waiting for a worker-loop rescan.
 */

export interface MissionGraphTaskLike {
  task_id: string;
  dependencies?: string[];
}

export interface MissionGraphInput {
  id: string;
  depends_on: string[];
  produces: string;
  consumes: string[];
  merge: 'namespace';
}

export interface MissionGraphHandoff<TOutcome = unknown, TResult = unknown> {
  from_task_id: string;
  status: string;
  outcome?: TOutcome;
  task_result?: TResult;
}

/** Compile mission task dependencies into explicit control + data edges. */
export function buildMissionGraphInputs(
  tasks: ReadonlyArray<MissionGraphTaskLike>
): MissionGraphInput[] {
  return tasks.map((task) => {
    const dependencies = Array.from(
      new Set(
        (Array.isArray(task.dependencies) ? task.dependencies : [])
          .map((dependency) => String(dependency || '').trim())
          .filter(Boolean)
      )
    );
    const channel = `mission-task:${task.task_id}`;
    return {
      id: task.task_id,
      depends_on: dependencies,
      produces: channel,
      consumes: dependencies.map((dependency) => `mission-task:${dependency}`),
      merge: 'namespace',
    };
  });
}

/** Select only the predecessor handoffs visible to one graph node. */
export function collectMissionGraphHandoffs<TOutcome, TResult>(
  context: Record<string, unknown>,
  dependencies: ReadonlyArray<string>
): Array<MissionGraphHandoff<TOutcome, TResult>> {
  return dependencies.flatMap((dependency) => {
    const namespaced = context[dependency];
    if (!namespaced || typeof namespaced !== 'object') return [];
    const handoff = (namespaced as { handoff?: unknown }).handoff;
    return handoff && typeof handoff === 'object'
      ? [handoff as MissionGraphHandoff<TOutcome, TResult>]
      : [];
  });
}
