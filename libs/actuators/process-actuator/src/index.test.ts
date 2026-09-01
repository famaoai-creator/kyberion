import path from 'node:path';
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from '@agent/core/schema-loader';
import * as pathResolver from '@agent/core/path-resolver';
import { handleAction, parseProcessAction } from './index.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('process-actuator schema', () => {
  it('rejects malformed direct adapter input before dispatch', () => {
    expect(() => parseProcessAction(null)).toThrow('supported action');
    expect(() => parseProcessAction({ action: 'status', params: [] })).toThrow('params');
    expect(() => parseProcessAction({ action: 'pipeline', steps: {} })).toThrow('steps');
    expect(() => parseProcessAction({ action: 'list', context: [] })).toThrow('context');
    expect(parseProcessAction({ action: 'list' })).toEqual({ action: 'list', params: {} });
  });

  it('accepts supported process actions', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.join(pathResolver.rootDir(), 'knowledge/product/schemas/process-action.schema.json')
    );

    expect(
      validate({
        action: 'spawn',
        params: {
          resourceId: 'proc-schema-1',
          ownerId: 'mission-controller',
          ownerType: 'mission',
          kind: 'worker',
          command: 'node',
          args: ['--version'],
        },
      }),
      JSON.stringify(validate.errors || [])
    ).toBe(true);

    expect(
      validate({
        action: 'status',
        params: {
          resourceId: 'proc-schema-1',
        },
      }),
      JSON.stringify(validate.errors || [])
    ).toBe(true);
  });

  it('rejects unsupported process actions', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.join(pathResolver.rootDir(), 'knowledge/product/schemas/process-action.schema.json')
    );

    expect(
      validate({
        action: 'unsupported',
        params: {},
      })
    ).toBe(false);
  });
});

describe('process-actuator path boundaries', () => {
  it('rejects a spawn cwd outside the repository before process creation', async () => {
    await expect(
      handleAction({
        action: 'spawn',
        params: {
          resourceId: 'external-cwd-test',
          ownerId: 'mission-controller',
          ownerType: 'mission',
          kind: 'worker',
          command: 'node',
          cwd: '/tmp/external-process-cwd',
        },
      } as any)
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
  });
});
