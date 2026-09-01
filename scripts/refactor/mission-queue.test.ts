import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  compileSchemaFromPath,
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import { dispatchNextQueuedMission, enqueueMission } from './mission-queue.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;
const QUEUE_DIR = pathResolver.shared('runtime/memory');
const QUEUE_PATH = path.join(QUEUE_DIR, 'mission-queue-schema-test.jsonl');

describe('mission-queue', () => {
  beforeEach(() => {
    safeRmSync(QUEUE_PATH, { force: true });
    if (!safeExistsSync(QUEUE_DIR)) safeMkdir(QUEUE_DIR, { recursive: true });
  });

  it('appends queue entries that satisfy the schema', async () => {
    await enqueueMission(QUEUE_PATH, 'MSN-TEST-SCHEMA', 'confidential', 7, ['MSN-DEP-1']);
    const raw = safeReadFile(QUEUE_PATH, { encoding: 'utf8' }) as string;
    const entry = JSON.parse(raw.trim().split('\n')[0] || '{}');
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      pathResolver.rootResolve('knowledge/product/schemas/mission-queue.schema.json')
    );
    const valid = validate(entry);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('skips malformed records when selecting the next mission', async () => {
    safeWriteFile(
      QUEUE_PATH,
      [
        '[]',
        JSON.stringify({
          mission_id: 'MSN-BAD',
          tier: 'confidential',
          priority: 'urgent',
          status: 'pending',
          enqueued_at: new Date().toISOString(),
          dependencies: [],
        }),
        JSON.stringify({
          mission_id: 'MSN-GOOD',
          tier: 'confidential',
          priority: 1,
          status: 'pending',
          enqueued_at: new Date().toISOString(),
          dependencies: [],
        }),
      ].join('\n') + '\n'
    );

    const dispatched: string[] = [];
    await dispatchNextQueuedMission(
      QUEUE_PATH,
      () => ({ ok: true, missing: [] }),
      async (missionId) => {
        dispatched.push(missionId);
      }
    );

    expect(dispatched).toEqual(['MSN-GOOD']);
  });
});
