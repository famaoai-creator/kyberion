/**
 * Registers every seam calibration adapter for the `seam:select` CLI.
 * Each seam keeps its adapter next to its own code; add one import + call here.
 */

import { registerSeamCalibrationAdapter } from '@agent/core/seam-calibration';
import { ocrProviderCalibrationAdapter } from './ocr-provider.js';
import { browserAutomationRuntimeCalibrationAdapter } from './browser-automation-runtime.js';
import { speechToTextBridgeCalibrationAdapter } from './speech-to-text-bridge.js';
import { streamingSttBridgeCalibrationAdapter } from './streaming-stt-bridge.js';
import { imageGenerationProviderCalibrationAdapter } from './image-generation-provider.js';
import { musicGenerationProviderCalibrationAdapter } from './music-generation-provider.js';
import { videoGenerationProviderCalibrationAdapter } from './video-generation-provider.js';
import { voiceTtsEngineCalibrationAdapter } from './voice-tts-engine.js';

let registered = false;

export function registerSeamCalibrationAdapters(): void {
  if (registered) return;
  registered = true;
  registerSeamCalibrationAdapter(ocrProviderCalibrationAdapter);
  registerSeamCalibrationAdapter(browserAutomationRuntimeCalibrationAdapter);
  registerSeamCalibrationAdapter(speechToTextBridgeCalibrationAdapter);
  registerSeamCalibrationAdapter(streamingSttBridgeCalibrationAdapter);
  registerSeamCalibrationAdapter(imageGenerationProviderCalibrationAdapter);
  registerSeamCalibrationAdapter(musicGenerationProviderCalibrationAdapter);
  registerSeamCalibrationAdapter(videoGenerationProviderCalibrationAdapter);
  registerSeamCalibrationAdapter(voiceTtsEngineCalibrationAdapter);
}
