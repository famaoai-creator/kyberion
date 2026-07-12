import { createVirtualCameraBridge } from '../libs/core/virtual-camera-bridge.js';
import * as path from 'node:path';

async function main() {
  const outputPath = process.argv[2] || 'active/shared/tmp/user_face.jpg';
  const cameraBridge = createVirtualCameraBridge();
  const probe = await cameraBridge.probe();

  if (!probe.available) {
    console.error(`Camera is not available: ${probe.reason || 'unknown'}`);
    process.exit(1);
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
    console.error(`Failed to capture photo: ${err.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
