import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import {
  loadMissionNextTaskObjectsAtPath,
  loadMissionNextTaskRecordsAtPath,
  parseMissionNextTaskObjects,
  parseMissionNextTaskRecords,
} from './mission-next-task-reader.js';

const loaderRoot = pathResolver.sharedTmp('mission-next-task-loader-test');
const loaderMissionId = 'MSN-NEXT-TASK-LOADER';
const loaderPath = path.join(loaderRoot, loaderMissionId, 'NEXT_TASKS.json');

afterEach(() => {
  safeRmSync(loaderRoot, { recursive: true, force: true });
});

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

describe('loadMissionNextTaskRecordsAtPath', () => {
  it('loads a mission-bound NEXT_TASKS projection through its schema', () => {
    safeMkdir(path.dirname(loaderPath), { recursive: true });
    safeWriteFile(loaderPath, JSON.stringify([{ task_id: 'review-1', status: 'completed' }]));

    expect(loadMissionNextTaskRecordsAtPath(loaderPath, loaderMissionId)).toEqual([
      { task_id: 'review-1', status: 'completed' },
    ]);
    expect(loadMissionNextTaskObjectsAtPath(loaderPath, loaderMissionId)).toEqual([
      { task_id: 'review-1', status: 'completed' },
    ]);
  });

  it('rejects non-regular and cross-mission NEXT_TASKS paths', () => {
    safeMkdir(path.dirname(loaderPath), { recursive: true });
    expect(() =>
      loadMissionNextTaskRecordsAtPath(path.dirname(loaderPath), loaderMissionId)
    ).toThrow('[MISSION_NEXT_TASKS]');
    safeWriteFile(loaderPath, JSON.stringify([]));
    expect(() => loadMissionNextTaskRecordsAtPath(loaderPath, 'MSN-OTHER')).toThrow(
      '[MISSION_NEXT_TASKS_SCOPE_MISMATCH]'
    );
  });

  it('rejects a symlinked NEXT_TASKS resource before loading it', () => {
    safeMkdir(path.dirname(loaderPath), { recursive: true });
    const targetPath = path.join(path.dirname(loaderPath), 'target.json');
    const linkPath = path.join(path.dirname(loaderPath), 'linked-NEXT_TASKS.json');
    safeWriteFile(targetPath, JSON.stringify([{ task_id: 'linked-task' }]));
    safeSymlinkSync(targetPath, linkPath);

    expect(() => loadMissionNextTaskObjectsAtPath(linkPath, loaderMissionId)).toThrow(
      '[RESOURCE_PATH_SYMLINK]'
    );
  });
});
