import {
  parseMissionNextTaskRecords,
  type MissionNextTaskRecord,
} from '@agent/core/mission-next-task-reader';
import type { MissionAssetCategory } from './mission-progress-client';

export { findLatestMissionHandoff } from './mission-progress-client';
export type { MissionAssetCategory, MissionHandoffSummary } from './mission-progress-client';

export type NextTaskRecord = MissionNextTaskRecord;

export interface MissionAssetSummary {
  path: string;
  category: MissionAssetCategory;
  sizeBytes: number;
  updatedAt: string;
}

export interface MissionProgressSnapshot {
  missionId: string;
  boardStatus: string;
  boardStepsTotal: number;
  boardStepsDone: number;
  boardStepsActive: number;
  boardStepsPending: number;
  nextTasksTotal: number;
  nextTasksPending: number;
  nextTasksCompleted: number;
  dependencies: string[];
  generatedAssets: MissionAssetSummary[];
}

export function parseTaskBoard(
  taskBoard: string
): Omit<
  MissionProgressSnapshot,
  'missionId' | 'nextTasksTotal' | 'nextTasksPending' | 'nextTasksCompleted'
> {
  const statusMatch = taskBoard.match(/^## Status:\s+(.+)$/m);
  const stepLines = taskBoard.match(/^- \[(?: |x|~)\] Step .+$/gm) || [];
  let boardStepsDone = 0;
  let boardStepsActive = 0;
  let boardStepsPending = 0;

  for (const line of stepLines) {
    if (line.includes('[x]')) {
      boardStepsDone += 1;
    } else if (line.includes('[~]')) {
      boardStepsActive += 1;
    } else {
      boardStepsPending += 1;
    }
  }

  return {
    boardStatus: statusMatch?.[1]?.trim() || 'Unknown',
    boardStepsTotal: stepLines.length,
    boardStepsDone,
    boardStepsActive,
    boardStepsPending,
    dependencies: [],
    generatedAssets: [],
  };
}

export function summarizeNextTasks(
  tasks: NextTaskRecord[]
): Pick<MissionProgressSnapshot, 'nextTasksTotal' | 'nextTasksPending' | 'nextTasksCompleted'> {
  let nextTasksPending = 0;
  let nextTasksCompleted = 0;

  for (const task of tasks) {
    const status = task.status || 'planned';
    if (status === 'completed' || status === 'done' || status === 'accepted') {
      nextTasksCompleted += 1;
    } else {
      nextTasksPending += 1;
    }
  }

  return {
    nextTasksTotal: tasks.length,
    nextTasksPending,
    nextTasksCompleted,
  };
}

/** Parse the persisted task list before it enters either Chronos progress projection. */
export function parseNextTaskRecords(value: unknown): NextTaskRecord[] | null {
  return parseMissionNextTaskRecords(value, 'NEXT_TASKS');
}

export function extractMissionDependencies(
  relationships: Record<string, unknown> | undefined | null
): string[] {
  if (!relationships || typeof relationships !== 'object') return [];
  const prerequisites = Array.isArray(relationships.prerequisites)
    ? relationships.prerequisites.filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      )
    : [];
  const dependsOn = Array.isArray((relationships as Record<string, unknown>).depends_on)
    ? ((relationships as Record<string, unknown>).depends_on as unknown[]).filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      )
    : [];
  return Array.from(new Set([...prerequisites, ...dependsOn]));
}

export function normalizeMissionAssets(assets: MissionAssetSummary[]): MissionAssetSummary[] {
  const seen = new Set<string>();
  return assets
    .filter((asset) => asset.path && !asset.path.endsWith('/'))
    .filter((asset) => {
      if (seen.has(asset.path)) return false;
      seen.add(asset.path);
      return true;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
