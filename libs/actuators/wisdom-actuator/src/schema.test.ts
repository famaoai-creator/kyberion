import path from 'node:path';
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath, pathResolver } from '@agent/core';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('wisdom-actuator schema', () => {
  it('accepts supported wisdom actions', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.join(pathResolver.rootDir(), 'schemas/wisdom-action.schema.json'));

    expect(
      validate({
        action: 'knowledge_search',
        params: {
          query: 'voice generation',
        },
      }),
      JSON.stringify(validate.errors || []),
    ).toBe(true);

    expect(
      validate({
        action: 'knowledge_import',
        params: {
          source_path: 'knowledge/public/tmp/import.json',
        },
      }),
      JSON.stringify(validate.errors || []),
    ).toBe(true);
  });

  it('rejects unsupported wisdom actions', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.join(pathResolver.rootDir(), 'schemas/wisdom-action.schema.json'));

    expect(
      validate({
        action: 'unsupported',
        params: {},
      }),
    ).toBe(false);
  });
});
