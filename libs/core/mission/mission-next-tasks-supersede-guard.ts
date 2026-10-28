/**
 * M2: a stale NEXT_TASKS.json write never undoes a supersede, and only
 * `mission_controller supersede-task` (human-approved) introduces one. Every
 * writer of the board applies this against the copy on disk, read right
 * before its write: the shared `writeMissionNextTasks` and the orchestration
 * progress controller (which adds its own status/rework merge on top).
 */
import { createLogger } from '../logger.js';
import type {
  MissionTaskDependencyRewrite,
  MissionTaskSupersededRecord,
} from './mission-orchestration-worker-contracts.js';

const logger = createLogger('mission-next-tasks');

interface SupersedeView {
  task_id?: unknown;
  status?: unknown;
  dependencies?: unknown;
  superseded?: MissionTaskSupersededRecord;
  dependencies_rewritten_from?: MissionTaskDependencyRewrite[];
}

const view = (task: object): SupersedeView => task as SupersedeView;
const taskId = (task: object): string => String(view(task).task_id ?? '');
const isSuperseded = (task: object | undefined): boolean =>
  task !== undefined && view(task).status === 'superseded';

function mergeRewrites(
  onDisk: MissionTaskDependencyRewrite[],
  incoming: MissionTaskDependencyRewrite[]
): MissionTaskDependencyRewrite[] {
  const merged = [...onDisk];
  for (const rewrite of incoming) {
    if (!merged.some((known) => known.from === rewrite.from && known.to === rewrite.to)) {
      merged.push(rewrite);
    }
  }
  return merged;
}

/**
 * The task a dependency resolves to through every rewrite: a replacement can
 * itself be superseded later (T1 → T2 → T3), so one step is not enough.
 * Stops at a repeated id (supersede-task refuses cycles; this never loops).
 */
function followRewrites(dependency: string, rewrites: MissionTaskDependencyRewrite[]): string {
  const seen = new Set([dependency]);
  let current = dependency;
  for (let step = 0; step < rewrites.length; step++) {
    const next = rewrites.find((rewrite) => rewrite.from === current)?.to;
    if (!next || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current;
}

export interface SupersedeGuardOptions {
  /** supersede-task's own write: it may introduce a `superseded` task. */
  allowSupersede?: boolean;
}

/**
 * The incoming board with every supersede on disk kept:
 *  - a task superseded on disk is frozen: its on-disk entry is kept as it
 *    is, whatever the incoming copy says;
 *  - each dependency rewrite a supersede made is re-applied to the incoming
 *    dependencies (old id → replacement); other dependency edits are kept;
 *  - an on-disk superseded task, or the replacement a supersede named, that
 *    the incoming list lacks is kept;
 *  - a `superseded` status the incoming copy introduces is dropped (the
 *    on-disk status is kept) unless `allowSupersede`.
 */
export function guardSupersedeState<T extends object, U extends object = T>(
  missionId: string,
  incoming: T[],
  onDisk: U[],
  options: SupersedeGuardOptions = {}
): Array<T | U> {
  const existingById = new Map(onDisk.map((task) => [taskId(task), task]));
  const merged: Array<T | U> = incoming.map((task): T | U => {
    const existing = existingById.get(taskId(task));
    if (isSuperseded(task) && !isSuperseded(existing) && !options.allowSupersede) {
      logger.warn(
        `task ${taskId(task)} not written as superseded — only supersede-task can supersede a task | the status on disk is kept; supersede it with pnpm mission supersede-task ${missionId} ${taskId(task)} --by <new_task_id> --reason <text> --request-approval | mission=${missionId}`
      );
      const rest = { ...task, status: existing ? (view(existing).status ?? 'planned') : 'planned' };
      delete (rest as SupersedeView).superseded;
      return rest;
    }
    if (!existing) return task;
    // A superseded task is frozen: the entry on disk is kept as it is.
    if (isSuperseded(existing) && view(existing).superseded) return existing;
    // Both lists: a later supersede-task write appends its own rewrite to the
    // incoming copy, and a stale copy lacks the ones made since its read.
    const rewrites = mergeRewrites(
      view(existing).dependencies_rewritten_from ?? [],
      view(task).dependencies_rewritten_from ?? []
    );
    const dependencies = view(task).dependencies ?? view(existing).dependencies;
    const dependenciesOut =
      rewrites.length > 0 && Array.isArray(dependencies)
        ? [
            ...new Set(
              dependencies.map((dependency) => followRewrites(String(dependency), rewrites))
            ),
          ]
        : undefined;
    if (!dependenciesOut) return task;
    return {
      ...task,
      ...(dependenciesOut
        ? { dependencies: dependenciesOut, dependencies_rewritten_from: rewrites }
        : {}),
    };
  });
  const incomingIds = new Set(incoming.map(taskId));
  const replacementIds = new Set(
    onDisk
      .map((task) => (isSuperseded(task) ? view(task).superseded?.by_task_id : undefined))
      .filter((id): id is string => Boolean(id))
  );
  for (const existing of onDisk) {
    if (incomingIds.has(taskId(existing))) continue;
    if (isSuperseded(existing) || replacementIds.has(taskId(existing))) merged.push(existing);
  }
  return merged;
}
