import * as path from 'node:path';
import { getRegisteredEnvText } from './foundation/env.js';
import { safeExistsSync } from './secure-io.js';
import { getToolRuntimeRecord } from './tool-runtime-registry.js';

/**
 * Governed external-tool binary resolvers (WS1).
 *
 * Override order mirrors the blackhole-audio-bus reference pattern
 * (`opts.ffmpeg_bin ?? 'ffmpeg'`): explicit KYBERION_*_BIN env override
 * first, governed registry command second, hardcoded literal last so every
 * call site stays behavior-preserving when neither is configured.
 */

function firstConfiguredEnv(...names: string[]): string | null {
  for (const name of names) {
    const value = getRegisteredEnvText(name)?.trim();
    if (value) return value;
  }
  return null;
}

function registryCommand(toolId: string): string | null {
  try {
    const record = getToolRuntimeRecord(toolId);
    if (record.tool_id !== toolId) return null;
    const command = record.trial_backend.command?.trim();
    return command || null;
  } catch {
    return null;
  }
}

export function resolveExternalToolBin(
  toolId: string,
  envNames: string[],
  literalFallback: string
): string {
  return firstConfiguredEnv(...envNames) ?? registryCommand(toolId) ?? literalFallback;
}

export function resolveFfmpegBin(): string {
  return resolveExternalToolBin('ffmpeg', ['KYBERION_FFMPEG_BIN'], 'ffmpeg');
}

export function resolveFfprobeBin(): string {
  return resolveExternalToolBin('ffprobe', ['KYBERION_FFPROBE_BIN'], 'ffprobe');
}

export function resolveAdbBin(): string {
  const override = firstConfiguredEnv('KYBERION_ADB_BIN');
  if (override) return override;
  const androidHome = firstConfiguredEnv('ANDROID_HOME');
  const androidSdkRoot = firstConfiguredEnv('ANDROID_SDK_ROOT');
  for (const sdkRoot of [androidHome, androidSdkRoot]) {
    if (!sdkRoot) continue;
    const candidate = path.join(
      sdkRoot,
      'platform-tools',
      process.platform === 'win32' ? 'adb.exe' : 'adb'
    );
    try {
      if (safeExistsSync(candidate)) return candidate;
    } catch {
      continue;
    }
  }
  return registryCommand('adb') ?? 'adb';
}

export function resolveXcrunBin(): string {
  return resolveExternalToolBin('xcrun', ['KYBERION_XCRUN_BIN'], 'xcrun');
}

export function resolveXcodebuildBin(): string {
  return resolveExternalToolBin('xcodebuild', ['KYBERION_XCODEBUILD_BIN'], 'xcodebuild');
}

export function resolvePython3Bin(): string {
  return firstConfiguredEnv('KYBERION_PYTHON_BIN', 'KYBERION_PYTHON') ?? 'python3';
}

/** Pane-runtime multiplexer CLI (Herdr). Env override wins over registry. */
export function resolveHerdrBin(): string {
  return resolveExternalToolBin('herdr', ['KYBERION_AGENT_PANE_RUNTIME_BIN'], 'herdr');
}

/** macOS ImageSnap still-capture CLI for virtual-camera-capture. */
export function resolveImagesnapBin(): string {
  return resolveExternalToolBin('imagesnap', ['KYBERION_IMAGESNAP_BIN'], 'imagesnap');
}
