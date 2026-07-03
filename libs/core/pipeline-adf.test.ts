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
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/product/schemas/pipeline-adf.schema.json')
    );
    const pipeline = {
      action: 'pipeline',
      name: 'sample',
      steps: [{ id: 'step1', type: 'capture', op: 'goto', params: { url: 'https://example.com' } }],
    };

    expect(validate(pipeline)).toBe(true);
    expect(validatePipelineAdf(pipeline)).toEqual(pipeline);
  });

  it('rejects a pipeline ADF without steps', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/product/schemas/pipeline-adf.schema.json')
    );

    expect(
      validate({
        action: 'pipeline',
        name: 'sample',
      })
    ).toBe(false);
  });

  it('accepts Typed Flow steps with role/produces/consumes', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/product/schemas/pipeline-adf.schema.json')
    );
    const pipeline = {
      action: 'pipeline',
      steps: [
        {
          id: 'extract',
          role: 'source',
          op: 'media:pptx_extract',
          produces: { channel: 'pptx_design', type: 'PptxDesign' },
          params: { path: '/tmp/test.pptx' },
        },
        {
          id: 'derive',
          role: 'transform',
          op: 'media:theme_from_pptx_design',
          consumes: 'pptx_design',
          produces: 'active_theme',
          params: {},
        },
        {
          id: 'save',
          role: 'sink',
          op: 'media:save_brand_to_confidential',
          consumes: ['active_theme'],
          params: { tenant_slug: 'test' },
        },
      ],
    };
    expect(validate(pipeline)).toBe(true);
  });

  it('accepts step-level effort and budget policy declarations', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/product/schemas/pipeline-adf.schema.json')
    );
    const pipeline = {
      action: 'pipeline',
      steps: [
        {
          id: 'reasoning-step',
          op: 'reasoning:synthesize',
          effort: 'high',
          budget: {
            cost_cap_tokens: 1200,
            max_prompt_chars: 500,
            max_response_chars: 750,
            max_combined_chars: 1000,
            approval_required: true,
          },
          params: { instruction: 'Summarize the context' },
        },
      ],
    };

    expect(validate(pipeline)).toBe(true);
    expect(validatePipelineAdf(pipeline)).toEqual(pipeline);
  });

  it('accepts mixed legacy type + Typed Flow produces in the same pipeline', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/product/schemas/pipeline-adf.schema.json')
    );
    const pipeline = {
      action: 'pipeline',
      steps: [
        {
          id: 'old_style',
          type: 'capture',
          op: 'browser:goto',
          params: { url: 'https://example.com' },
        },
        { id: 'new_style', role: 'source', op: 'browser:snapshot', produces: 'snap', params: {} },
      ],
    };
    expect(validate(pipeline)).toBe(true);
  });
});
