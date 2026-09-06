import { pathResolver } from './path-resolver.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { assertSafeRepositoryPath, safeExecResult } from './secure-io.js';

export interface WindowsNativeImageRecognitionAvailability {
  ocr: boolean;
  description: boolean;
  helper?: string;
  reason?: string;
}

function helperPath(): string | undefined {
  const value = getRegisteredEnvText('KYBERION_WINDOWS_IMAGE_GENERATOR')?.trim();
  return value || undefined;
}

function invoke(helper: string, args: string[], timeoutMs = 60_000): any | null {
  const result = safeExecResult(helper, args, { timeoutMs, maxOutputMB: 4 });
  if (result.status !== 0) return null;
  try {
    return parseSafeJsonInput(result.stdout.trim(), 'Windows image recognition response');
  } catch {
    return null;
  }
}

/** Probe the optional MSIX helper that hosts Windows AI Imaging APIs. */
export function probeWindowsNativeImageRecognition(): WindowsNativeImageRecognitionAvailability {
  if (process.platform !== 'win32')
    return { ocr: false, description: false, reason: 'requires Windows' };
  const helper = helperPath();
  if (!helper) {
    return {
      ocr: false,
      description: false,
      reason: 'requires an MSIX helper with systemAIModels capability',
    };
  }
  const probe = invoke(helper, ['--probe-recognition'], 5_000);
  if (!probe)
    return {
      ocr: false,
      description: false,
      helper,
      reason: 'Windows image recognition probe failed',
    };
  return { ocr: probe.ocr === true, description: probe.description === true, helper };
}

export function recognizeTextWithWindowsNativeApi(imagePath: string): any | null {
  const safeImagePath = assertSafeRepositoryPath(pathResolver.rootResolve(imagePath), {
    allowMissingLeaf: true,
  });
  const helper = helperPath();
  if (!helper || process.platform !== 'win32') return null;
  return invoke(helper, ['--ocr', '--input', safeImagePath], 120_000);
}

export function describeImageWithWindowsNativeApi(imagePath: string): string | null {
  const safeImagePath = assertSafeRepositoryPath(pathResolver.rootResolve(imagePath), {
    allowMissingLeaf: true,
  });
  const helper = helperPath();
  if (!helper || process.platform !== 'win32') return null;
  const result = invoke(helper, ['--describe', '--input', safeImagePath], 120_000);
  return typeof result?.description === 'string' ? result.description : null;
}
