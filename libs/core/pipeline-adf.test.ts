import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from '@agent/core';
import { describe, expect, it } from 'vitest';
import { validatePipelineAdf } from './pipeline-contract.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('pipeline-adf', () => {
  it('accepts a minimal valid pipeline ADF', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(root, 'knowledge/public/schemas/pipeline-adf.schema.json'));
    const pipeline = {
      action: 'pipeline',
      name: 'sample',
      steps: [
        { id: 'step1', type: 'capture', op: 'goto', params: { url: 'https://example.com' } },
      ],
    };

    expect(validate(pipeline)).toBe(true);
    expect(validatePipelineAdf(pipeline)).toEqual(pipeline);
  });

  it('rejects a pipeline ADF without steps', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(root, 'knowledge/public/schemas/pipeline-adf.schema.json'));

    expect(validate({
      action: 'pipeline',
      name: 'sample',
    })).toBe(false);
  });
});
