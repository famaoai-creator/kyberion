import { safeExecResult } from './secure-io.js';

export interface WindowsNativeImageGenerationAvailability {
  available: boolean;
  reason?: string;
  helper?: string;
}

export interface WindowsNativeImageGenerationRequest {
  prompt: string;
  outputPath: string;
  width?: number;
  height?: number;
  seed?: number;
}

/**
 * Boundary for the Windows App SDK ImageGenerator API.
 *
 * The API is only available to an MSIX-packaged WinAppSDK 2.0 experimental
 * app with the systemAIModels capability on a Copilot+ NPU device. Kyberion
 * remains a Node process, so the native call is delegated to an optional
 * packaged helper rather than attempting to load WinRT from Node.
 */
export function probeWindowsNativeImageGeneration(): WindowsNativeImageGenerationAvailability {
  if (process.platform !== 'win32') return { available: false, reason: 'requires Windows' };
  const helper = process.env.KYBERION_WINDOWS_IMAGE_GENERATOR?.trim();
  if (!helper) {
    return {
      available: false,
      reason: 'requires an MSIX WinAppSDK helper with systemAIModels capability',
    };
  }
  const probe = safeExecResult(helper, ['--probe'], { timeoutMs: 5_000, maxOutputMB: 1 });
  return probe.status === 0
    ? { available: true, helper }
    : {
        available: false,
        reason: probe.stderr.trim() || 'Windows image helper probe failed',
        helper,
      };
}

export function generateImageWithWindowsNativeApi(
  request: WindowsNativeImageGenerationRequest
): string | null {
  const availability = probeWindowsNativeImageGeneration();
  if (!availability.available || !availability.helper) return null;
  const result = safeExecResult(
    availability.helper,
    [
      '--generate',
      '--prompt',
      request.prompt,
      '--output',
      request.outputPath,
      ...(request.width ? ['--width', String(request.width)] : []),
      ...(request.height ? ['--height', String(request.height)] : []),
      ...(request.seed === undefined ? [] : ['--seed', String(request.seed)]),
    ],
    { timeoutMs: 300_000, maxOutputMB: 2 }
  );
  if (result.status !== 0) return null;
  return request.outputPath;
}
