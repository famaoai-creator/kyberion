import * as path from 'node:path';
import { safeExistsSync, safeMkdir } from '../../../secure-io.js';
import {
  generateImageLocallyWithApplePlayground,
  probeAppleImageGeneration,
} from '../../../apple-intelligence-bridge.js';
import {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationProvider,
} from '../../image-generation-types.js';
import {
  generateImageWithWindowsNativeApi,
  probeWindowsNativeImageGeneration,
} from '../../../windows-native-image-generation-bridge.js';
import { getFallbackTargetPath } from '../provider-support.js';

export class WindowsNativeImageGenerationProvider implements ImageGenerationProvider {
  readonly id = 'windows_native';
  readonly costTier = 'self_hosted';
  readonly dataPolicy = 'local_only';
  readonly executionLocality = 'local';

  async isAvailable(): Promise<boolean> {
    return probeWindowsNativeImageGeneration().available;
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const startedAt = Date.now();
    const outputPath = getFallbackTargetPath(request).replace(/\.[^.]+$/, '.png');
    const generated = generateImageWithWindowsNativeApi({
      prompt: request.prompt,
      outputPath,
      ...(request.width ? { width: request.width } : {}),
      ...(request.height ? { height: request.height } : {}),
    });
    return generated
      ? {
          status: 'succeeded',
          provider: this.id,
          path: generated,
          elapsedMs: Date.now() - startedAt,
        }
      : {
          status: 'failed',
          provider: this.id,
          elapsedMs: Date.now() - startedAt,
          error: 'windows_native_image_generation_unavailable',
        };
  }
}

function getApplePlaygroundTargetPath(request: ImageGenerationRequest): string {
  const targetPath = getFallbackTargetPath(request);
  const extension = path.extname(targetPath);
  if (extension.toLowerCase() === '.png') return targetPath;
  return extension ? `${targetPath.slice(0, -extension.length)}.png` : `${targetPath}.png`;
}

export class ApplePlaygroundImageGenerationProvider implements ImageGenerationProvider {
  readonly id = 'apple_playground';
  readonly backendIds = ['media-generation.apple_playground'];
  readonly costTier = 'self_hosted';
  readonly dataPolicy = 'local_only';
  readonly executionLocality = 'local';

  async isAvailable(): Promise<boolean> {
    return (await probeAppleImageGeneration()).available;
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const startedAt = Date.now();
    const targetPath = getApplePlaygroundTargetPath(request);
    const outputDir = path.dirname(targetPath);
    if (!safeExistsSync(outputDir)) {
      safeMkdir(outputDir, { recursive: true });
    }

    try {
      const generated = await generateImageLocallyWithApplePlayground(request.prompt, targetPath, {
        ...(request.style ? { style: request.style } : {}),
      });
      if (!generated) {
        return {
          status: 'failed',
          provider: this.id,
          elapsedMs: Date.now() - startedAt,
          error: 'apple_playground_generation_unavailable',
        };
      }
      return {
        status: 'succeeded',
        provider: this.id,
        path: generated.path,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error: any) {
      return {
        status: 'failed',
        provider: this.id,
        elapsedMs: Date.now() - startedAt,
        error: error?.message || 'apple_playground_generation_failed',
      };
    }
  }
}
