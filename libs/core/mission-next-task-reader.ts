import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { parseSafeJsonObjectValue } from './foundation/json.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';

function missionNextTasksCatalog(filePath: string) {
  return defineCatalog<Array<Record<string, unknown>>>({
    id: 'mission-next-tasks',
    path: filePath,
    schema: pathResolver.knowledge('product/schemas/mission-next-tasks.schema.json'),
  });
}

/** The fields needed by mission gates and progress projections. */
export interface MissionNextTaskRecord {
  task_id?: string;
  status?: string;
}

/** Load NEXT_TASKS through the mission-boundary schema before projecting it. */
export function loadMissionNextTaskObjectsAtPath(
  filePath: string,
  expectedMissionId: string
): Array<Record<string, unknown>> | null {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[MISSION_NEXT_TASKS] NEXT_TASKS.json must be a regular file: ${filePath}`);
  }
  const missionId = expectedMissionId.trim().toUpperCase();
  if (path.basename(path.dirname(safeFilePath)).toUpperCase() !== missionId) {
    throw new Error(
      `[MISSION_NEXT_TASKS_SCOPE_MISMATCH] NEXT_TASKS.json is outside mission ${missionId}: ${filePath}`
    );
  }
  if (!safeExistsSync(safeFilePath)) return null;
  const parsed = missionNextTasksCatalog(safeFilePath).load();
  return parseMissionNextTaskObjects(parsed, safeFilePath);
}

/** Load the task/status projection used by read-only mission gates. */
export function loadMissionNextTaskRecordsAtPath(
  filePath: string,
  expectedMissionId: string
): MissionNextTaskRecord[] | null {
  const objects = loadMissionNextTaskObjectsAtPath(filePath, expectedMissionId);
  return objects ? parseMissionNextTaskRecords(objects, filePath) : null;
}

/** Parse NEXT_TASKS entries while preserving fields needed by mutating flows. */
export function parseMissionNextTaskObjects(
  value: unknown,
  label = 'NEXT_TASKS.json'
): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;

  const records: Array<Record<string, unknown>> = [];
  for (const [index, candidate] of value.entries()) {
    try {
      const record = parseSafeJsonObjectValue(candidate, `${label}[${index}]`);
      if (record.task_id !== undefined && typeof record.task_id !== 'string') return null;
      if (record.status !== undefined && typeof record.status !== 'string') return null;
      records.push(record);
    } catch {
      return null;
    }
  }
  return records;
}

/**
 * Parse the small, shared projection of NEXT_TASKS.json used by read models.
 *
 * Full task dispatch validation remains in validatePlannedNextTasks. This
 * reader only admits object entries and the fields consumed by projections,
 * so malformed persisted data cannot become an implicitly approved outcome.
 */
export function parseMissionNextTaskRecords(
  value: unknown,
  label = 'NEXT_TASKS.json'
): MissionNextTaskRecord[] | null {
  const objects = parseMissionNextTaskObjects(value, label);
  if (!objects) return null;

  const records: MissionNextTaskRecord[] = [];
  for (const record of objects) {
    const taskId = typeof record.task_id === 'string' ? record.task_id : undefined;
    const status = typeof record.status === 'string' ? record.status : undefined;

    records.push({
      ...(taskId === undefined ? {} : { task_id: taskId }),
      ...(status === undefined ? {} : { status }),
    } satisfies MissionNextTaskRecord);
  }
  return records;
}
