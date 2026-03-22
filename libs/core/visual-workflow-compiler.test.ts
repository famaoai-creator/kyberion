import { describe, expect, it } from 'vitest';
import { compileImageGenerationADF, compileVideoGenerationADF } from './visual-workflow-compiler.js';

describe('visual workflow compiler', () => {
  it('builds an SDXL image workflow from image-generation-adf', () => {
    const result = compileImageGenerationADF({
      kind: 'image-generation-adf',
      version: '1.0.0',
      intent: 'country_cover',
      prompt: 'country road at golden hour',
      negative_prompt: 'blurry',
      canvas: { width: 1024, height: 1024 },
      output: { format: 'png', filename_prefix: 'country-cover' },
    } as any);

    expect(result.workflow['1']).toEqual(expect.objectContaining({ class_type: 'CheckpointLoaderSimple' }));
    expect(result.workflow['7']).toEqual({
      class_type: 'SaveImage',
      inputs: { images: ['6', 0], filename_prefix: 'country-cover' },
    });
  });

  it('hydrates embedded video workflow templates from video-generation-adf', () => {
    const result = compileVideoGenerationADF({
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
    } as any);

    expect(result.workflow['1']).toEqual({
      class_type: 'TextNode',
      inputs: { text: 'cinematic driving shot', fps: '24', duration: '5' },
    });
  });
});
