/**
 * Registers every seam calibration adapter for the `seam:select` CLI.
 * Each seam keeps its adapter next to its own code; add one import + call here.
 */

import { registerSeamCalibrationAdapter } from '@agent/core/seam-calibration';
import { ocrProviderCalibrationAdapter } from './seam-calibration/ocr-provider.js';
import { browserAutomationRuntimeCalibrationAdapter } from './seam-calibration/browser-automation-runtime.js';
import { imageGenerationProviderCalibrationAdapter } from './seam-calibration/image-generation-provider.js';
import { musicGenerationProviderCalibrationAdapter } from './seam-calibration/music-generation-provider.js';
import { videoGenerationProviderCalibrationAdapter } from './seam-calibration/video-generation-provider.js';

let registered = false;

export function registerSeamCalibrationAdapters(): void {
  if (registered) return;
  registered = true;
  registerSeamCalibrationAdapter(ocrProviderCalibrationAdapter);
  registerSeamCalibrationAdapter(browserAutomationRuntimeCalibrationAdapter);
  registerSeamCalibrationAdapter(imageGenerationProviderCalibrationAdapter);
  registerSeamCalibrationAdapter(musicGenerationProviderCalibrationAdapter);
  registerSeamCalibrationAdapter(videoGenerationProviderCalibrationAdapter);
}
