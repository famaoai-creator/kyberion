import * as path from 'node:path';
import { getRegisteredEnvText } from '../foundation/env.js';
import { safeExistsSync } from '../secure-io.js';
import { findInstalledManagedBinary, getToolRuntimeRecord } from './tool-runtime-registry.js';

/**
 * Governed external-tool binary resolvers (WS1).
 *
 * Override order mirrors the blackhole-audio-bus reference pattern
 * (`opts.ffmpeg_bin ?? 'ffmpeg'`): explicit KYBERION_*_BIN env override
 * first, an installed `managed_binary` in the tool's managed env second,
 * governed registry command third, hardcoded literal last so every
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

function managedBinary(toolId: string): string | null {
  try {
    return findInstalledManagedBinary(toolId);
  } catch {
    return null;
  }
}

export function resolveExternalToolBin(
  toolId: string,
  envNames: string[],
  literalFallback: string
): string {
  return (
    firstConfiguredEnv(...envNames) ??
    managedBinary(toolId) ??
    registryCommand(toolId) ??
    literalFallback
  );
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

/** Lightpanda headless browser (CDP server) for the browser-automation-runtime seam. */
export function resolveLightpandaBin(): string {
  return resolveExternalToolBin('lightpanda', ['KYBERION_LIGHTPANDA_BIN'], 'lightpanda');
}

/**
 * macOS locations of the Tailscale CLI, most specific first: the symlink the
 * app's "Install CLI" creates, a Homebrew formula, then the binary inside the
 * app bundle (`brew install --cask tailscale-app`), which works as the CLI
 * without the extra install step.
 */
export const TAILSCALE_DARWIN_CANDIDATES = [
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
] as const;

/** Tailscale CLI for the public-ingress provider `tailscale-funnel`. */
export function resolveTailscaleBin(
  deps: { platform?: NodeJS.Platform; exists?: (candidate: string) => boolean } = {}
): string {
  const override = firstConfiguredEnv('KYBERION_TAILSCALE_BIN');
  if (override) return override;
  const managed = managedBinary('tailscale');
  if (managed) return managed;
  if ((deps.platform ?? process.platform) === 'darwin') {
    const exists =
      deps.exists ??
      ((candidate: string) => {
        try {
          return safeExistsSync(candidate);
        } catch {
          return false;
        }
      });
    const found = TAILSCALE_DARWIN_CANDIDATES.find((candidate) => exists(candidate));
    if (found) return found;
  }
  return registryCommand('tailscale') ?? 'tailscale';
}

/** yt-dlp video fetcher for libs/core/video-ingest (never self-updated). */
export function resolveYtDlpBin(): string {
  return resolveExternalToolBin('yt_dlp', ['KYBERION_YTDLP_BIN'], 'yt-dlp');
}
