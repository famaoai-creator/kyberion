import {
  ensureMacOSSwiftBinary,
  resolveMacOSHostApp,
  runMacOSNativeBinary,
} from './macos-native-automation.js';

export type PermissionWarmupKind = 'microphone' | 'camera' | 'screen_recording';
export const PERMISSION_WARMUP_KINDS: readonly PermissionWarmupKind[] = [
  'microphone',
  'camera',
  'screen_recording',
];
/** Meeting pain point first: only the microphone is requested unless asked otherwise. */
export const DEFAULT_PERMISSION_WARMUP_KINDS: readonly PermissionWarmupKind[] = ['microphone'];

export type PermissionWarmupState =
  'granted' | 'denied' | 'restricted' | 'not_determined' | 'unsupported' | 'unknown';

export interface PermissionWarmupKindResult {
  before: PermissionWarmupState;
  after: PermissionWarmupState;
  /** Present when the permission is still denied: where the operator can enable it. */
  remedy?: string;
  /** Present when this kind's helper run failed; other kinds are unaffected. */
  error?: string;
}

export interface PermissionWarmupResult {
  supported: boolean;
  results: Partial<Record<PermissionWarmupKind, PermissionWarmupKindResult>>;
  /** The host app macOS attributes the grants to. */
  host_app?: string;
  reason?: string;
}

export const PERMISSION_SETTINGS_PANE: Record<PermissionWarmupKind, string> = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  screen_recording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
};

const STATES: readonly string[] = [
  'granted',
  'denied',
  'restricted',
  'not_determined',
  'unsupported',
  'unknown',
];
// A user may take a while to answer the OS dialog; the Swift side waits up to 60s.
const WARMUP_TIMEOUT_MS = 65000;

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
  kinds: readonly PermissionWarmupKind[] = DEFAULT_PERMISSION_WARMUP_KINDS,
  hostApp: string | undefined = resolveMacOSHostApp()
): PermissionWarmupResult {
  if (process.platform !== 'darwin')
    return { supported: false, results: {}, reason: 'macos_only_capability' };
  // Without a terminal host the responsible process may lack a usage description,
  // and macOS aborts it on requestAccess. Refuse instead of crashing a daemon.
  if (!hostApp) return { supported: true, results: {}, reason: 'host_app_unknown' };
  const requested = [...new Set(kinds)].filter((kind) => PERMISSION_WARMUP_KINDS.includes(kind));
  let binary: string;
  try {
    binary = ensureMacOSSwiftBinary('libs/core/macos-permission-warmup.swift', 'warmup-');
  } catch (error) {
    return {
      supported: true,
      results: {},
      host_app: hostApp,
      reason: error instanceof Error ? error.message : 'native_warmup_failed',
    };
  }
  const results: PermissionWarmupResult['results'] = {};
  // One helper run per kind, so a failed request never loses the other kinds' results.
  for (const kind of requested) {
    try {
      const raw = runMacOSNativeBinary(
        binary,
        [JSON.stringify({ kinds: [kind] })],
        WARMUP_TIMEOUT_MS
      );
      const entry = raw[kind] as { before?: unknown; after?: unknown } | undefined;
      const after = state(entry?.after);
      results[kind] = {
        before: state(entry?.before),
        after,
        ...(needsSettings(kind, after) ? { remedy: PERMISSION_SETTINGS_PANE[kind] } : {}),
      };
    } catch (error) {
      results[kind] = {
        before: 'unknown',
        after: 'unknown',
        error: error instanceof Error ? error.message : 'native_warmup_failed',
      };
    }
  }
  return { supported: true, results, host_app: hostApp };
}
