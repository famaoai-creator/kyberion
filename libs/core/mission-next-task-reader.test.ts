import { describe, expect, it } from 'vitest';
import {
  parseMissionNextTaskObjects,
  parseMissionNextTaskRecords,
} from './mission-next-task-reader.js';

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

describe('parseMissionNextTaskObjects', () => {
  it('preserves fields for lifecycle flows that write the task object back', () => {
    const tasks = parseMissionNextTaskObjects([
      { task_id: 'task-1', status: 'planned', deliverable: 'evidence/task-1.md' },
    ]);
    expect(tasks).toEqual([
      { task_id: 'task-1', status: 'planned', deliverable: 'evidence/task-1.md' },
    ]);
  });

  it('rejects non-object entries and dangerous nested keys', () => {
    expect(parseMissionNextTaskObjects([{ task_id: 'task-1' }, 'invalid'])).toBeNull();
    expect(
      parseMissionNextTaskObjects([
        JSON.parse('{"task_id":"task-1","metadata":{"constructor":{}}}'),
      ])
    ).toBeNull();
  });
});
