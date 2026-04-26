import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { compileSchemaFromPath } from './schema-loader.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('a2a-task-contract schema', () => {
  it('accepts a governed A2A task payload', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(root, 'knowledge/public/schemas/a2a-task-contract.schema.json'));

    const valid = {
      intent: 'request_mission_work',
      text: '進捗をまとめて',
      context: {
        mission_id: 'MSN-schema-1',
        team_role: 'mission-controller',
        execution_mode: 'task',
        channel: 'slack',
      },
    };

    expect(validate(valid)).toBe(true);
  });

  it('rejects payloads without the required team role context', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(root, 'knowledge/public/schemas/a2a-task-contract.schema.json'));

    const invalid = {
      intent: 'request_mission_work',
      text: '進捗をまとめて',
      context: {
        mission_id: 'MSN-schema-1',
      },
    };

    expect(validate(invalid)).toBe(false);
  });
});
