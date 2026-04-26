import path from 'node:path';
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from './schema-loader.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('bridge-request schema', () => {
  it('accepts valid bridge requests', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(process.cwd(), 'schemas/bridge-request.schema.json'));

    expect(
      validate({
        intent: 'request_marketing_material',
        context: {
          channel: 'slack',
        },
        params: {
          language: 'ja',
        },
      }),
      JSON.stringify(validate.errors || []),
    ).toBe(true);
  });

  it('rejects invalid bridge requests', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(process.cwd(), 'schemas/bridge-request.schema.json'));

    expect(validate({ context: {} })).toBe(false);
  });
});
