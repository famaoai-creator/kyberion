import { createVirtualCameraBridge } from '@agent/core/virtual-camera-bridge';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';

export function resolveCapturePhotoPath(outputPath = 'active/shared/tmp/user_face.jpg'): string {
  return assertSafeRepositoryPath(pathResolver.resolve(outputPath), { allowMissingLeaf: true });
}

async function main(outputPath = 'active/shared/tmp/user_face.jpg') {
  const resolvedOutputPath = resolveCapturePhotoPath(outputPath);
  const cameraBridge = createVirtualCameraBridge();
  const probe = await cameraBridge.probe();

  if (!probe.available) {
    throw new Error(`Camera is not available: ${probe.reason || 'unknown'}`);
  }

  try {
    const result = await cameraBridge.capturePhoto({
      save_path: resolvedOutputPath,
      camera_intent: 'reference',
      subject_hint: 'Face capture for avatar generation pipeline',
    });
    return { backend: probe.backend, save_path: result.save_path };
  } catch (err: any) {
    throw new Error(`Failed to capture photo: ${err.message}`);
  }
}

export const runCapturePhoto = defineScript({
  name: 'capture-photo',
  flags: ['json'],
  async run(context) {
    const result = await main(context.positional[0]);
    context.print(result);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'capture_photo.ts') ||
  isDirectScript(import.meta.url, 'capture_photo.js')
)
  void runCapturePhoto();
