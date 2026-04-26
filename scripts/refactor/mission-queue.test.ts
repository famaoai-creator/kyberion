import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { beforeEach, describe, expect, it } from 'vitest';
import { compileSchemaFromPath, pathResolver, safeExistsSync, safeMkdir, safeReadFile, safeRmSync } from '@agent/core';
import { enqueueMission } from './mission-queue.js';

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
    const validate = compileSchemaFromPath(ajv, pathResolver.rootResolve('schemas/mission-queue.schema.json'));
    const valid = validate(entry);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });
});
