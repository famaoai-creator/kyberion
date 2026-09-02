import { parseSafeJsonObjectValue } from './foundation/json.js';

/** The fields needed by mission gates and progress projections. */
export interface MissionNextTaskRecord {
  task_id?: string;
  status?: string;
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
