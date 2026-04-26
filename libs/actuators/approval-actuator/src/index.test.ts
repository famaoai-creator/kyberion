import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { compileSchemaFromPath, pathResolver } from '@agent/core';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('approval-actuator', () => {
  it('emits approval actions that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.join(pathResolver.rootDir(), 'schemas/approval-action.schema.json'));
    const action = {
      action: 'create',
      params: {
        role: 'mission_controller',
        channel: 'terminal',
        storageChannel: 'terminal',
        threadTs: '1714060800.000100',
        correlationId: 'corr-approval-demo-1',
        requestedBy: 'agent-1',
        requestKind: 'secret_mutation',
        draft: {
          title: 'Rotate GitHub secret',
          summary: 'Rotate the GitHub token for the approval gate demo.',
          severity: 'high',
        },
      },
    };
    const valid = validate(action);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });
});
