import { describe, expect, it } from 'vitest';
import {
  generateImageWithWindowsNativeApi,
  probeWindowsNativeImageGeneration,
} from './windows-native-image-generation-bridge.js';

describe('windows native image generation bridge', () => {
  it.runIf(process.platform !== 'win32')(
    'reports unavailable off Windows without probing the helper',
    () => {
      expect(probeWindowsNativeImageGeneration()).toEqual({
        available: false,
        reason: 'requires Windows',
      });
      expect(
        generateImageWithWindowsNativeApi({ prompt: 'a fox', outputPath: 'out.png' })
      ).toBeNull();
    }
  );
});
