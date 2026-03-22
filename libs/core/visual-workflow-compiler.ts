import type { KyberionImageGenerationADF } from './src/types/image-generation-adf.js';
import type { KyberionVideoGenerationADF } from './src/types/video-generation-adf.js';

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'kyberion-media';
}

function seedOrRandom(seed?: number): number {
  return Number.isInteger(seed) ? Number(seed) : Math.floor(Date.now() % 2147483647);
}

function getVideoWorkflowTemplate(templateName: string): Record<string, any> {
  if (templateName === 'basic_text_clip') {
    return {
      '1': {
        class_type: 'TextNode',
        inputs: {
          prompt: '{{prompt}}',
          negative_prompt: '{{negative_prompt}}',
          duration: '{{duration_sec}}',
          fps: '{{fps}}',
          seed: '{{seed}}',
        },
      },
      '2': {
        class_type: 'SaveVideo',
        inputs: {
          filename_prefix: '{{filename_prefix}}',
          format: '{{format}}',
          frames: ['1', 0],
        },
      },
    };
  }
  throw new Error(`Unsupported video workflow_template: ${templateName}`);
}

export function compileImageGenerationADF(adf: KyberionImageGenerationADF) {
  const checkpoint = adf.engine?.checkpoint || 'sd_xl_turbo_1.0_fp16.safetensors';
  const filenamePrefix = adf.output.filename_prefix || slugify(adf.intent || 'image-generation');
  return {
    workflow: {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: adf.prompt, clip: ['1', 1] } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: adf.negative_prompt || '', clip: ['1', 1] } },
      '4': { class_type: 'EmptyLatentImage', inputs: { width: adf.canvas.width, height: adf.canvas.height, batch_size: 1 } },
      '5': {
        class_type: 'KSampler',
        inputs: {
          model: ['1', 0],
          positive: ['2', 0],
          negative: ['3', 0],
          latent_image: ['4', 0],
          seed: seedOrRandom(adf.engine?.seed),
          steps: adf.engine?.steps ?? 6,
          cfg: adf.engine?.cfg_scale ?? 1,
          sampler_name: adf.engine?.sampler_name || 'euler',
          scheduler: adf.engine?.scheduler || 'simple',
          denoise: 1,
        },
      },
      '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
      '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: filenamePrefix } },
    },
    resolved: {
      filename_prefix: filenamePrefix,
      checkpoint,
      width: adf.canvas.width,
      height: adf.canvas.height,
    },
  };
}

export function compileVideoGenerationADF(adf: KyberionVideoGenerationADF) {
  const template =
    adf.engine.workflow_template === 'embedded'
      ? adf.engine.base_workflow
      : getVideoWorkflowTemplate(adf.engine.workflow_template);
  if (!template) {
    throw new Error('video-generation-adf currently requires either a supported named workflow_template or engine.base_workflow for embedded templates');
  }
  const filenamePrefix = adf.output.filename_prefix || slugify(adf.intent || 'video-generation');
  const workflow = JSON.parse(JSON.stringify(template));
  const replace = (value: any): any => {
    if (typeof value === 'string') {
      return value
        .replace(/{{\s*prompt\s*}}/g, adf.prompt)
        .replace(/{{\s*negative_prompt\s*}}/g, adf.negative_prompt || '')
        .replace(/{{\s*duration_sec\s*}}/g, String(adf.composition.duration_sec))
        .replace(/{{\s*fps\s*}}/g, String(adf.composition.fps || 24))
        .replace(/{{\s*seed\s*}}/g, String(seedOrRandom(adf.engine.seed)))
        .replace(/{{\s*filename_prefix\s*}}/g, filenamePrefix)
        .replace(/{{\s*format\s*}}/g, adf.output.format);
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
    }
    return value;
  };
  return {
    workflow: replace(workflow),
    resolved: {
      filename_prefix: filenamePrefix,
      duration_sec: adf.composition.duration_sec,
      fps: adf.composition.fps || 24,
      workflow_template: adf.engine.workflow_template,
    },
  };
}
