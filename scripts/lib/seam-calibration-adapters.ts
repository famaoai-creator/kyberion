/**
 * Registers every seam calibration adapter for the `seam:select` CLI.
 * Each seam keeps its adapter next to its own code; add one import + call here.
 */

import { registerSeamCalibrationAdapter } from '@agent/core/seam-calibration';
import { ocrProviderCalibrationAdapter } from './seam-calibration/ocr-provider.js';
import { browserAutomationRuntimeCalibrationAdapter } from './seam-calibration/browser-automation-runtime.js';

let registered = false;

export function registerSeamCalibrationAdapters(): void {
  if (registered) return;
  registered = true;
  registerSeamCalibrationAdapter(ocrProviderCalibrationAdapter);
  registerSeamCalibrationAdapter(browserAutomationRuntimeCalibrationAdapter);
}
