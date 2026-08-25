import { createVirtualCameraBridge } from '@agent/core';
import * as path from 'node:path';
import { defineScript, isDirectScript } from './lib/harness.js';

async function main(argv: string[]) {
  const outputPath = argv[0] || 'active/shared/tmp/user_face.jpg';
  const cameraBridge = createVirtualCameraBridge();
  const probe = await cameraBridge.probe();

  if (!probe.available) {
    throw new Error(`Camera is not available: ${probe.reason || 'unknown'}`);
  }

  console.log(`Using camera backend: ${probe.backend}`);

  try {
    const result = await cameraBridge.capturePhoto({
      save_path: path.resolve(outputPath),
      camera_intent: 'reference',
      subject_hint: 'Face capture for avatar generation pipeline',
    });
    console.log(`Successfully saved photo to: ${result.save_path}`);
  } catch (err: any) {
    throw new Error(`Failed to capture photo: ${err.message}`);
  }
}

export const runCapturePhoto = defineScript({
  name: 'capture-photo',
  flags: [],
  run(context) {
    return main(context.argv);
  },
});

if (
  isDirectScript(import.meta.url, 'capture_photo.ts') ||
  isDirectScript(import.meta.url, 'capture_photo.js')
)
  void runCapturePhoto();
