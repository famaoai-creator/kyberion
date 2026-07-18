import { safeExecResult } from './secure-io.js';
import { activateApplication } from './apple-event-bridge.js';
import { listKnownAppCapabilities, type KnownAppCapability } from './os-app-adapters.js';

export const MACOS_AUTOMATION_BRIDGE_ID = 'macos-automation-bridge';

export type MacOSAutomationPermissionStatus = 'granted' | 'denied' | 'unsupported' | 'unknown';

export interface MacOSAutomationPermissions {
  automation: MacOSAutomationPermissionStatus;
  accessibility: MacOSAutomationPermissionStatus;
  screen_recording: MacOSAutomationPermissionStatus;
}

export interface MacOSAutomationProbe {
  bridge_id: typeof MACOS_AUTOMATION_BRIDGE_ID;
  platform: NodeJS.Platform;
  available: boolean;
  permissions: MacOSAutomationPermissions;
  known_applications: KnownAppCapability[];
  reason?: string;
}

export interface MacOSAutomationActivationResult {
  application: string;
  activated: boolean;
  reason?: 'unsupported_platform' | 'application_not_allowlisted';
}

export interface MacOSAutomationBridge {
  probe(): MacOSAutomationProbe;
  listCapabilities(): KnownAppCapability[];
  activateKnownApplication(application: string): MacOSAutomationActivationResult;
}

const UNSUPPORTED_PERMISSIONS: MacOSAutomationPermissions = {
  automation: 'unsupported',
  accessibility: 'unsupported',
  screen_recording: 'unsupported',
};

function isDarwin(): boolean {
  return process.platform === 'darwin';
}

function buildProbeReason(result: ReturnType<typeof safeExecResult>): string {
  const detail =
    result.stderr.trim() ||
    result.error?.message ||
    `osascript exited with status ${result.status}`;
  return `macos_permission_probe_failed: ${detail}`;
}

function probe(): MacOSAutomationProbe {
  const knownApplications = listKnownAppCapabilities();
  if (!isDarwin()) {
    return {
      bridge_id: MACOS_AUTOMATION_BRIDGE_ID,
      platform: process.platform,
      available: false,
      permissions: { ...UNSUPPORTED_PERMISSIONS },
      known_applications: knownApplications,
      reason: 'macos_only_capability',
    };
  }

  const result = safeExecResult(
    'osascript',
    [
      '-e',
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ],
    { timeoutMs: 2000, maxOutputMB: 1 }
  );
  if (result.status === 0) {
    return {
      bridge_id: MACOS_AUTOMATION_BRIDGE_ID,
      platform: process.platform,
      available: true,
      permissions: {
        automation: 'granted',
        accessibility: 'granted',
        screen_recording: 'unknown',
      },
      known_applications: knownApplications,
      reason: 'screen_recording_probe_not_attempted',
    };
  }

  return {
    bridge_id: MACOS_AUTOMATION_BRIDGE_ID,
    platform: process.platform,
    available: false,
    permissions: {
      automation: 'denied',
      accessibility: 'denied',
      screen_recording: 'unknown',
    },
    known_applications: knownApplications,
    reason: buildProbeReason(result),
  };
}

function activateKnownApplication(application: string): MacOSAutomationActivationResult {
  const requested = application.trim();
  const known = listKnownAppCapabilities().find(
    (entry) => entry.application.toLowerCase() === requested.toLowerCase()
  );
  if (!known) {
    return { application: requested, activated: false, reason: 'application_not_allowlisted' };
  }
  if (!isDarwin()) {
    return { application: known.application, activated: false, reason: 'unsupported_platform' };
  }
  activateApplication(known.application);
  return { application: known.application, activated: true };
}

export const macosAutomationBridge: MacOSAutomationBridge = {
  probe,
  listCapabilities: listKnownAppCapabilities,
  activateKnownApplication,
};
