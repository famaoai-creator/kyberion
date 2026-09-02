import { describe, expect, it } from 'vitest';
import { parseMissionNextTaskRecords } from './mission-next-task-reader.js';

describe('parseMissionNextTaskRecords', () => {
  it('keeps the task and status projection for valid records', () => {
    expect(
      parseMissionNextTaskRecords([
        { task_id: 'review-1', status: 'completed', description: 'ignored' },
        { task_id: 'review-2' },
        { status: 'planned' },
      ])
    ).toEqual([
      { task_id: 'review-1', status: 'completed' },
      { task_id: 'review-2' },
      { status: 'planned' },
    ]);
  });

  it('rejects malformed roots, entries, and consumed field types', () => {
    expect(parseMissionNextTaskRecords({ task_id: 'review-1' })).toBeNull();
    expect(parseMissionNextTaskRecords([{ task_id: 'review-1' }, null])).toBeNull();
    expect(parseMissionNextTaskRecords([{ task_id: 42 }])).toBeNull();
    expect(parseMissionNextTaskRecords([{ status: 42 }])).toBeNull();
  });

  it('rejects dangerous object keys through the safe JSON parser', () => {
    expect(
      parseMissionNextTaskRecords([JSON.parse('{"__proto__":{"status":"completed"}}')])
    ).toBeNull();
  });
});
