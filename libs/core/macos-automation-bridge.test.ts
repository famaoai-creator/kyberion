import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeProbe = vi.hoisted(() => vi.fn());
const safeExec = vi.hoisted(() => vi.fn());
vi.mock('./macos-native-automation.js', () => ({ probeMacOSNativeAutomation: nativeProbe }));
vi.mock('./secure-io.js', () => ({ safeExec }));

const originalPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}
const granted = {
  available: true,
  automation: 'granted',
  browser_automation: 'granted',
  accessibility: 'granted',
  screen_recording: 'granted',
};

describe('macos-automation-bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeProbe.mockReturnValue({ ...granted });
    setPlatform('darwin');
  });
  afterEach(() => setPlatform(originalPlatform));

  it('does not execute a probe on non-macOS platforms', async () => {
    setPlatform('linux');
    const { macosAutomationBridge } = await import('./macos-automation-bridge.js');
    expect(macosAutomationBridge.probe()).toMatchObject({
      platform: 'linux',
      available: false,
      permissions: {
        automation: 'unsupported',
        accessibility: 'unsupported',
        screen_recording: 'unsupported',
      },
      reason: 'macos_only_capability',
    });
    expect(nativeProbe).not.toHaveBeenCalled();
  });

  it('reports independent native grants and source readiness', async () => {
    const { macosAutomationBridge } = await import('./macos-automation-bridge.js');
    expect(macosAutomationBridge.probe()).toMatchObject({
      available: true,
      permissions: { automation: 'granted', accessibility: 'granted', screen_recording: 'granted' },
      sourceAvailability: {
        active_window: true,
        focused_input: true,
        browser_tabs: true,
        screen_frame: true,
      },
    });
    expect(nativeProbe).toHaveBeenCalledTimes(1);
    expect(safeExec).not.toHaveBeenCalled();
  });

  it('does not infer Accessibility from an Apple Events grant', async () => {
    nativeProbe.mockReturnValue({
      ...granted,
      accessibility: 'denied',
      screen_recording: 'unknown',
    });
    const { macosAutomationBridge } = await import('./macos-automation-bridge.js');
    expect(macosAutomationBridge.probe()).toMatchObject({
      available: false,
      permissions: { automation: 'granted', accessibility: 'denied', screen_recording: 'unknown' },
      sourceAvailability: {
        active_window: false,
        focused_input: false,
        browser_tabs: true,
        screen_frame: false,
      },
    });
  });

  it('keeps native AX observations ready when application events are denied', async () => {
    nativeProbe.mockReturnValue({ ...granted, automation: 'denied', browser_automation: 'denied' });
    const { macosAutomationBridge } = await import('./macos-automation-bridge.js');
    expect(macosAutomationBridge.probe()).toMatchObject({
      available: true,
      permissions: { automation: 'denied', accessibility: 'granted' },
      sourceAvailability: {
        active_window: true,
        focused_input: true,
        browser_tabs: false,
        screen_frame: true,
      },
    });
  });

  it('requires the Chrome-specific permission rather than a System Events grant', async () => {
    nativeProbe.mockReturnValue({ ...granted, browser_automation: 'unknown' });
    const { macosAutomationBridge } = await import('./macos-automation-bridge.js');
    expect(macosAutomationBridge.probe().sourceAvailability?.browser_tabs).toBe(false);
  });

  it('reports unavailable native tooling as unknown, preserving its reason', async () => {
    nativeProbe.mockReturnValue({
      available: false,
      automation: 'unknown',
      browser_automation: 'unknown',
      accessibility: 'unknown',
      screen_recording: 'unknown',
      reason: 'native_probe_failed',
    });
    const { macosAutomationBridge } = await import('./macos-automation-bridge.js');
    const probe = macosAutomationBridge.probe();
    expect(probe.available).toBe(false);
    expect(probe.permissions).toEqual({
      automation: 'unknown',
      accessibility: 'unknown',
      screen_recording: 'unknown',
    });
    expect(probe.reason).toContain('native_probe_failed');
    expect(Object.values(probe.sourceAvailability ?? {})).not.toContain(true);
  });

  it('only activates known applications through the allowlist', async () => {
    const { macosAutomationBridge } = await import('./macos-automation-bridge.js');
    expect(macosAutomationBridge.activateKnownApplication('Safari')).toEqual({
      application: 'Safari',
      activated: false,
      reason: 'application_not_allowlisted',
    });
    expect(macosAutomationBridge.activateKnownApplication('finder')).toEqual({
      application: 'Finder',
      activated: true,
    });
    expect(safeExec).toHaveBeenCalledWith('osascript', [
      '-e',
      'tell application "Finder" to activate',
    ]);
  });
});
