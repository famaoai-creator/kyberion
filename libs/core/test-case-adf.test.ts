import path from 'node:path';
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from './schema-loader.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('test-case-adf schema', () => {
  it('accepts valid test-case adf records', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(process.cwd(), 'knowledge/public/schemas/test-case-adf.schema.json'));

    expect(
      validate({
        kind: 'test-case-adf',
        app_id: 'sample-app',
        cases: [
          {
            case_id: 'TC-1',
            title: 'Happy path',
            objective: 'Verify FR-1',
            steps: ['do x'],
            expected: ['outcome y'],
            automation_backend: 'browser',
          },
        ],
      }),
      JSON.stringify(validate.errors || []),
    ).toBe(true);
  });

  it('rejects invalid test-case adf records', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(process.cwd(), 'knowledge/public/schemas/test-case-adf.schema.json'));

    expect(
      validate({
        kind: 'test-case-adf',
        app_id: '',
        cases: [],
      }),
    ).toBe(false);
  });
});
