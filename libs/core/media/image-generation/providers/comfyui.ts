import { logger } from '../../../core.js';
import { executeServicePreset } from '../../../service/service-engine.js';
import { probeServiceRuntime } from '../../../service/service-runtime-registry.js';
import {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationProvider,
} from '../../image-generation-types.js';
import { compileComfyUiImageRequest } from '../../../visual-workflow-compiler.js';
import { governImageProvider } from '../admission.js';
import { getFallbackTargetPath } from '../provider-support.js';

export class ComfyUiImageGenerationProvider implements ImageGenerationProvider {
  constructor() {
    this.generate = governImageProvider(this).generate;
  }
  readonly id = 'comfyui';
  readonly backendIds = ['media-generation.comfyui'];
  readonly costTier = 'self_hosted';
  readonly dataPolicy = 'local_only';
  readonly executionLocality = 'local';

  async isAvailable(): Promise<boolean> {
    const resolution = await probeServiceRuntime('comfyui', 'trial');
    return resolution.available;
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const startedAt = Date.now();
    try {
      const targetPath = request.targetPath ? getFallbackTargetPath(request) : undefined;
      const workflow = compileComfyUiImageRequest(request, targetPath);
      const res = await executeServicePreset('media-generation', 'generate_image', {
        prompt: request.prompt,
        workflow,
        aspect_ratio: request.aspectRatio,
        target_path: targetPath,
        await_completion: request.awaitCompletion ?? true,
      });

      return {
        status: res?.prompt_id ? 'submitted' : 'succeeded',
        path: res?.copied_to || res?.target_path || targetPath,
        provider: this.id,
        promptId: res?.prompt_id,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error: any) {
      logger.error(`[image_generation_bridge] ComfyUI generation failed: ${error.message}`);
      return {
        status: 'failed',
        provider: this.id,
        elapsedMs: Date.now() - startedAt,
        error: error.message || 'comfyui_generation_failed',
      };
    }
  }
}
