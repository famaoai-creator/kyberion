import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const safeExecResult = vi.fn();
const safeExec = vi.fn();

vi.mock('./secure-io.js', () => ({ safeExecResult, safeExec }));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('macos-automation-bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform(originalPlatform);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('does not execute a probe on non-macOS platforms', async () => {
    setPlatform('linux');
    const { macosAutomationBridge } = await import('./macos-automation-bridge.js');

    expect(macosAutomationBridge.probe()).toMatchObject({
      bridge_id: 'macos-automation-bridge',
      platform: 'linux',
      available: false,
      permissions: {
        automation: 'unsupported',
        accessibility: 'unsupported',
        screen_recording: 'unsupported',
      },
      reason: 'macos_only_capability',
    });
    expect(safeExecResult).not.toHaveBeenCalled();
  });

  it('reports granted automation/accessibility and unknown screen recording after a successful probe', async () => {
    setPlatform('darwin');
    safeExecResult.mockReturnValue({ stdout: 'Finder\n', stderr: '', status: 0 });
    const { macosAutomationBridge } = await import('./macos-automation-bridge.js');

    const result = macosAutomationBridge.probe();

    expect(result).toMatchObject({
      available: true,
      permissions: {
        automation: 'granted',
        accessibility: 'granted',
        screen_recording: 'unknown',
      },
      reason: 'screen_recording_probe_not_attempted',
    });
    expect(safeExecResult).toHaveBeenCalledWith(
      'osascript',
      ['-e', expect.stringContaining('System Events')],
      { timeoutMs: 2000, maxOutputMB: 1 }
    );
  });

  it('reports permission denial without throwing', async () => {
    setPlatform('darwin');
    safeExecResult.mockReturnValue({
      stdout: '',
      stderr: 'Not authorized to send Apple events',
      status: 1,
    });
    const { macosAutomationBridge } = await import('./macos-automation-bridge.js');

    expect(macosAutomationBridge.probe()).toMatchObject({
      available: false,
      permissions: { automation: 'denied', accessibility: 'denied', screen_recording: 'unknown' },
      reason: 'macos_permission_probe_failed: Not authorized to send Apple events',
    });
  });

  it('only activates known applications through the allowlist', async () => {
    setPlatform('darwin');
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
