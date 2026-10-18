import { ensureMacOSSwiftBinary, runMacOSNativeBinary } from './macos-native-automation.js';

export type PermissionWarmupKind = 'microphone' | 'camera' | 'screen_recording';
export const PERMISSION_WARMUP_KINDS: readonly PermissionWarmupKind[] = [
  'microphone',
  'camera',
  'screen_recording',
];
/** Meeting pain point first: only the microphone is requested unless asked otherwise. */
export const DEFAULT_PERMISSION_WARMUP_KINDS: readonly PermissionWarmupKind[] = ['microphone'];

export type PermissionWarmupState =
  'granted' | 'denied' | 'not_determined' | 'unsupported' | 'unknown';

export interface PermissionWarmupKindResult {
  before: PermissionWarmupState;
  after: PermissionWarmupState;
  /** Present when the permission is still denied: where the operator can enable it. */
  remedy?: string;
}

export interface PermissionWarmupResult {
  supported: boolean;
  results: Partial<Record<PermissionWarmupKind, PermissionWarmupKindResult>>;
  reason?: string;
}

export const PERMISSION_SETTINGS_PANE: Record<PermissionWarmupKind, string> = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  screen_recording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
};

const STATES: readonly string[] = ['granted', 'denied', 'not_determined', 'unsupported', 'unknown'];
// A user may take a while to answer the OS dialog; the Swift side waits up to 60s per kind.
const WARMUP_TIMEOUT_MS = 60000 * PERMISSION_WARMUP_KINDS.length + 5000;

function state(value: unknown): PermissionWarmupState {
  return typeof value === 'string' && STATES.includes(value)
    ? (value as PermissionWarmupState)
    : 'unknown';
}

// Screen recording only takes effect after enabling the host app in System Settings
// (and restarting it), so any non-granted result points there.
function needsSettings(kind: PermissionWarmupKind, after: PermissionWarmupState): boolean {
  return after === 'denied' || (kind === 'screen_recording' && after !== 'granted');
}

export function warmupMacOSPermissions(
  kinds: readonly PermissionWarmupKind[] = DEFAULT_PERMISSION_WARMUP_KINDS
): PermissionWarmupResult {
  if (process.platform !== 'darwin')
    return { supported: false, results: {}, reason: 'macos_only_capability' };
  const requested = [...new Set(kinds)].filter((kind) => PERMISSION_WARMUP_KINDS.includes(kind));
  try {
    const binary = ensureMacOSSwiftBinary('libs/core/macos-permission-warmup.swift', 'warmup-');
    const raw = runMacOSNativeBinary(
      binary,
      [JSON.stringify({ kinds: requested })],
      WARMUP_TIMEOUT_MS
    );
    const results: PermissionWarmupResult['results'] = {};
    for (const kind of requested) {
      const entry = raw[kind] as { before?: unknown; after?: unknown } | undefined;
      const after = state(entry?.after);
      results[kind] = {
        before: state(entry?.before),
        after,
        ...(needsSettings(kind, after) ? { remedy: PERMISSION_SETTINGS_PANE[kind] } : {}),
      };
    }
    return { supported: true, results };
  } catch (error) {
    return {
      supported: true,
      results: {},
      reason: error instanceof Error ? error.message : 'native_warmup_failed',
    };
  }
}
