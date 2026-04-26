import path from 'node:path';
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from './schema-loader.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('computer-action schema', () => {
  it('accepts deprecated KUCA actions', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(process.cwd(), 'schemas/computer-action.schema.json'));

    expect(
      validate({
        actions: [
          {
            type: 'click',
            x: 100,
            y: 200,
            button: 'left',
            target: 'browser',
          },
          {
            type: 'voice_output',
            text: 'hello',
            target: 'os',
          },
        ],
      }),
      JSON.stringify(validate.errors || []),
    ).toBe(true);
  });

  it('rejects invalid KUCA actions', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(process.cwd(), 'schemas/computer-action.schema.json'));

    expect(
      validate({
        actions: [
          {
            type: 'unsupported',
          },
        ],
      }),
    ).toBe(false);
  });
});
