import path from 'node:path';
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath, pathResolver } from '@agent/core';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('presence-actuator schema', () => {
  it('accepts supported presence actions', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.join(pathResolver.rootDir(), 'schemas/presence-action.schema.json'));

    expect(
      validate({
        action: 'dispatch',
        params: {
          channel: 'general',
          payload: {
            text: 'hello world',
          },
        },
      }),
      JSON.stringify(validate.errors || []),
    ).toBe(true);

    expect(
      validate({
        action: 'receive_event',
        params: {
          channel: 'general',
          payload: {
            event_type: 'click',
          },
        },
      }),
      JSON.stringify(validate.errors || []),
    ).toBe(true);
  });

  it('rejects unsupported presence actions', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.join(pathResolver.rootDir(), 'schemas/presence-action.schema.json'));

    expect(
      validate({
        action: 'unsupported',
        params: {},
      }),
    ).toBe(false);
  });
});
