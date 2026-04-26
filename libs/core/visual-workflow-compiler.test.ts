import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { compileSchemaFromPath } from '@agent/core';
import { compileImageGenerationADF, compileVideoGenerationADF } from './visual-workflow-compiler.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('visual workflow compiler', () => {
  it('builds an SDXL image workflow from image-generation-adf', () => {
    const adf = {
      kind: 'image-generation-adf',
      version: '1.0.0',
      intent: 'country_cover',
      prompt: 'country road at golden hour',
      negative_prompt: 'blurry',
      canvas: { width: 1024, height: 1024 },
      output: { format: 'png', filename_prefix: 'country-cover' },
    } as any;
    const result = compileImageGenerationADF(adf);

    expect(result.workflow['1']).toEqual(expect.objectContaining({ class_type: 'CheckpointLoaderSimple' }));
    expect(result.workflow['7']).toEqual({
      class_type: 'SaveImage',
      inputs: { images: ['6', 0], filename_prefix: 'country-cover' },
    });
  });

  it('emits image-generation-adf that matches the schema', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(root, 'knowledge/public/schemas/image-generation-adf.schema.json'));

    expect(validate({
      kind: 'image-generation-adf',
      version: '1.0.0',
      intent: 'country_cover',
      prompt: 'country road at golden hour',
      negative_prompt: 'blurry',
      canvas: { width: 1024, height: 1024 },
      output: { format: 'png', filename_prefix: 'country-cover' },
    })).toBe(true);
  });

  it('hydrates embedded video workflow templates from video-generation-adf', () => {
    const adf = {
      kind: 'video-generation-adf',
      version: '1.0.0',
      prompt: 'cinematic driving shot',
      composition: { duration_sec: 5, fps: 24 },
      engine: {
        provider: 'comfyui',
        workflow_template: 'embedded',
        base_workflow: {
          '1': {
            class_type: 'TextNode',
            inputs: { text: '{{prompt}}', fps: '{{fps}}', duration: '{{duration_sec}}' },
          },
        },
      },
      output: { format: 'mp4', filename_prefix: 'drive-shot' },
    } as any;
    const result = compileVideoGenerationADF(adf);

    expect(result.workflow['1']).toEqual({
      class_type: 'TextNode',
      inputs: { text: 'cinematic driving shot', fps: '24', duration: '5' },
    });
  });

  it('emits video-generation-adf that matches the schema', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(root, 'knowledge/public/schemas/video-generation-adf.schema.json'));

    expect(validate({
      kind: 'video-generation-adf',
      version: '1.0.0',
      prompt: 'cinematic driving shot',
      composition: { duration_sec: 5, fps: 24 },
      engine: {
        provider: 'comfyui',
        workflow_template: 'embedded',
        base_workflow: {
          '1': {
            class_type: 'TextNode',
            inputs: { text: '{{prompt}}', fps: '{{fps}}', duration: '{{duration_sec}}' },
          },
        },
      },
      output: { format: 'mp4', filename_prefix: 'drive-shot' },
    })).toBe(true);
  });

  it('builds named video workflow templates without embedding raw base_workflow in the ADF', () => {
    const result = compileVideoGenerationADF({
      kind: 'video-generation-adf',
      version: '1.0.0',
      intent: 'country_drive_clip',
      prompt: 'cinematic driving shot',
      negative_prompt: 'glitch',
      composition: { duration_sec: 5, fps: 24 },
      engine: {
        provider: 'comfyui',
        workflow_template: 'basic_text_clip',
        seed: 42,
      },
      output: { format: 'mp4', filename_prefix: 'drive-shot' },
    } as any);

    expect(result.workflow['1']).toEqual({
      class_type: 'TextNode',
      inputs: {
        prompt: 'cinematic driving shot',
        negative_prompt: 'glitch',
        duration: '5',
        fps: '24',
        seed: '42',
      },
    });
    expect(result.workflow['2']).toEqual({
      class_type: 'SaveVideo',
      inputs: {
        filename_prefix: 'drive-shot',
        format: 'mp4',
        frames: ['1', 0],
      },
    });
    expect(result.resolved.workflow_template).toBe('basic_text_clip');
  });
});
