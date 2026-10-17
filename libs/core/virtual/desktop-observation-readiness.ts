import {
  assessDesktopObservationReadiness,
  type DesktopObservationReadiness,
} from './desktop-recording.js';
import { macosAutomationBridge } from '../macos-automation-bridge.js';
import { osAutomationBridge } from './os-automation-bridge.js';
import { createScreenCaptureBridge } from './screen-capture-bridge.js';

export async function probeDesktopObservationReadiness(): Promise<DesktopObservationReadiness[]> {
  if (process.platform === 'darwin') {
    return assessDesktopObservationReadiness(macosAutomationBridge.probe());
  }

  const sourceReadiness: Partial<
    Record<DesktopObservationReadiness['source_id'], { available: boolean; reason: string }>
  > = {};
  const screen = await createScreenCaptureBridge().probe();
  sourceReadiness.screen_frame = screen.available
    ? { available: true, reason: `screen_capture_backend_available:${screen.backend}` }
    : {
        available: false,
        reason: screen.reason ?? 'screen_capture_backend_unavailable',
      };

  if (process.platform === 'win32') {
    try {
      osAutomationBridge.detectFocusedInput();
      sourceReadiness.active_window = { available: true, reason: 'windows_uia_available' };
      sourceReadiness.focused_input = { available: true, reason: 'windows_uia_available' };
    } catch {
      sourceReadiness.active_window = {
        available: false,
        reason: 'windows_uia_unavailable:check desktop accessibility access',
      };
      sourceReadiness.focused_input = {
        available: false,
        reason: 'windows_uia_unavailable:check desktop accessibility access',
      };
    }

    try {
      const tabs = osAutomationBridge.listChromeTabs();
      sourceReadiness.browser_tabs =
        tabs.length > 0
          ? { available: true, reason: 'windows_chrome_tabs_observable' }
          : {
              available: false,
              reason: 'windows_chrome_tabs_unavailable:open Chrome with a visible tab',
            };
    } catch {
      sourceReadiness.browser_tabs = {
        available: false,
        reason: 'windows_chrome_uia_failed:check Chrome UI Automation availability',
      };
    }
  }

  return assessDesktopObservationReadiness(
    {
      platform: process.platform,
      available: false,
      permissions: { automation: 'unknown', accessibility: 'unknown', screen_recording: 'unknown' },
    },
    sourceReadiness
  );
}
