import { probeMacOSNativeAutomation } from './macos-native-automation.js';
import { activateApplication } from './apple-event-bridge.js';
import { listKnownAppCapabilities, type KnownAppCapability } from './virtual/os-app-adapters.js';

export const MACOS_AUTOMATION_BRIDGE_ID = 'macos-automation-bridge';

export type MacOSAutomationPermissionStatus =
  'granted' | 'denied' | 'restricted' | 'not_determined' | 'unsupported' | 'unknown';

export interface MacOSAutomationPermissions {
  automation: MacOSAutomationPermissionStatus;
  accessibility: MacOSAutomationPermissionStatus;
  screen_recording: MacOSAutomationPermissionStatus;
  /** Informational only: does not affect `available`, `sourceAvailability` or `reason`. */
  microphone?: MacOSAutomationPermissionStatus;
  camera?: MacOSAutomationPermissionStatus;
}

export interface MacOSAutomationProbe {
  bridge_id: typeof MACOS_AUTOMATION_BRIDGE_ID;
  platform: NodeJS.Platform;
  available: boolean;
  permissions: MacOSAutomationPermissions;
  host_app?: string;
  known_applications: KnownAppCapability[];
  sourceAvailability?: Partial<
    Record<'active_window' | 'browser_tabs' | 'focused_input' | 'screen_frame', boolean>
  >;
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

  const native = probeMacOSNativeAutomation();
  const uiAvailable = native.available && native.accessibility === 'granted';
  const permissions: MacOSAutomationPermissions = {
    automation: native.automation,
    accessibility: native.accessibility,
    screen_recording: native.screen_recording,
  };
  const unavailable = Object.entries(permissions)
    .filter(([, status]) => status !== 'granted')
    .map(([permission, status]) => `${permission}_permission_${status}`);
  if (native.reason) unavailable.unshift(native.reason);
  const capturePermissions = {
    ...(native.microphone ? { microphone: native.microphone } : {}),
    ...(native.camera ? { camera: native.camera } : {}),
  };
  return {
    bridge_id: MACOS_AUTOMATION_BRIDGE_ID,
    platform: process.platform,
    available: uiAvailable,
    permissions: { ...permissions, ...capturePermissions },
    ...(native.host_app ? { host_app: native.host_app } : {}),
    known_applications: knownApplications,
    sourceAvailability: {
      active_window: uiAvailable,
      focused_input: uiAvailable,
      browser_tabs: native.available && native.browser_automation === 'granted',
      screen_frame: native.available && native.screen_recording === 'granted',
    },
    ...(unavailable.length ? { reason: unavailable.join('; ') } : {}),
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
