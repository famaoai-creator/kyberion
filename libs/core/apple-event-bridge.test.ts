import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({
  getMacOSFocusedInput: vi.fn(),
  getMacOSScreenSize: vi.fn(),
  listMacOSAXWindows: vi.fn(),
  performMacOSMouseOperation: vi.fn(),
  probeMacOSNativeAutomation: vi.fn(),
}));
vi.mock('./macos-native-automation.js', () => native);
vi.mock('./secure-io.js', () => ({
  safeExec: vi.fn(() => ''),
  safeExecResult: vi.fn(() => ({ stdout: '', stderr: '', status: 0 })),
}));
const originalPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}
describe('apple-event-bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('darwin');
  });
  afterEach(() => setPlatform(originalPlatform));
  it('reads focused metadata through native Accessibility without application events', async () => {
    const state = {
      application: 'Codex',
      windowTitle: 'Current Chat',
      role: 'AXTextArea',
      description: 'Chat Input',
      editable: true,
    };
    native.getMacOSFocusedInput.mockReturnValue(state);
    const bridge = await import('./apple-event-bridge.js');
    const secureIo = await import('./secure-io.js');
    expect(bridge.detectFocusedInput()).toEqual(state);
    expect(secureIo.safeExec).not.toHaveBeenCalled();
  });
  it('queries AX window titles without depending on an application scripting dictionary', async () => {
    native.listMacOSAXWindows.mockReturnValue(['Document']);
    const bridge = await import('./apple-event-bridge.js');
    expect(bridge.getWindowList('Electron Editor')).toEqual(['Document']);
    expect(native.listMacOSAXWindows).toHaveBeenCalledWith('Electron Editor');
  });
  it('routes pointer operations through the native boundary', async () => {
    const bridge = await import('./apple-event-bridge.js');
    const secureIo = await import('./secure-io.js');
    bridge.clickAt(1, 2, 2);
    bridge.rightClickAt(3, 4);
    bridge.moveMouse(5, 6);
    bridge.scrollAt(7, 8, 'right', 4);
    bridge.dragFrom(9, 10, 11, 12);
    expect(native.performMacOSMouseOperation.mock.calls.map(([op]) => op)).toEqual([
      { type: 'click', x: 1, y: 2, button: 'left', count: 2 },
      { type: 'click', x: 3, y: 4, button: 'right', count: 1 },
      { type: 'move', x: 5, y: 6 },
      { type: 'scroll', x: 7, y: 8, direction: 'right', amount: 4 },
      { type: 'drag', fromX: 9, fromY: 10, toX: 11, toY: 12 },
    ]);
    expect(secureIo.safeExec).not.toHaveBeenCalled();
  });
  it('propagates native pointer permission refusal', async () => {
    native.performMacOSMouseOperation.mockImplementationOnce(() => {
      throw new Error('macos_accessibility_denied');
    });
    const bridge = await import('./apple-event-bridge.js');
    expect(() => bridge.clickAt(1, 2)).toThrow('macos_accessibility_denied');
  });
  it('reports UI automation only with an executable native boundary and AX grant', async () => {
    const bridge = await import('./apple-event-bridge.js');
    native.probeMacOSNativeAutomation.mockReturnValue({
      available: true,
      accessibility: 'granted',
    });
    expect(bridge.isUIAutomationAvailable()).toBe(true);
    native.probeMacOSNativeAutomation.mockReturnValue({ available: true, accessibility: 'denied' });
    expect(bridge.isUIAutomationAvailable()).toBe(false);
    native.probeMacOSNativeAutomation.mockReturnValue({
      available: false,
      accessibility: 'granted',
    });
    expect(bridge.isUIAutomationAvailable()).toBe(false);
  });
  it('uses native logical display dimensions', async () => {
    native.getMacOSScreenSize.mockReturnValue({ width: 1440, height: 900 });
    const bridge = await import('./apple-event-bridge.js');
    expect(bridge.getScreenSize()).toEqual({ width: 1440, height: 900 });
  });
  it('builds an activate application AppleScript call', async () => {
    const bridge = await import('./apple-event-bridge.js');
    const secureIo = await import('./secure-io.js');
    bridge.activateApplication('Safari');
    expect(secureIo.safeExec).toHaveBeenCalledWith('osascript', [
      '-e',
      'tell application "Safari" to activate',
    ]);
  });
  it('launches an application through the native launch boundary', async () => {
    const bridge = await import('./apple-event-bridge.js');
    const secureIo = await import('./secure-io.js');
    expect(bridge.launchApplication('Safari')).toBe(true);
    expect(secureIo.safeExecResult).toHaveBeenCalledWith('open', ['-a', 'Safari'], {
      timeoutMs: 10_000,
    });
  });
  it('sets window state through Accessibility actions with explicit matching', async () => {
    const bridge = await import('./apple-event-bridge.js');
    const secureIo = await import('./secure-io.js');
    vi.mocked(secureIo.safeExec).mockReturnValueOnce('true');
    expect(bridge.setWindowState('Safari', 'Settings', 'maximize', 'strict')).toBe(true);
    expect(vi.mocked(secureIo.safeExec).mock.calls.at(-1)?.[1]?.[1]).toContain(
      'perform action "AXZoom" of w'
    );
  });
  it('toggles dictation using the macOS key code helper', async () => {
    const bridge = await import('./apple-event-bridge.js');
    const secureIo = await import('./secure-io.js');
    bridge.toggleDictation(176);
    expect(secureIo.safeExec).toHaveBeenCalledWith('osascript', [
      '-e',
      'tell application "System Events" to key code 176',
    ]);
  });
  it('builds a system notification AppleScript call', async () => {
    const bridge = await import('./apple-event-bridge.js');
    const secureIo = await import('./secure-io.js');
    bridge.systemNotify('Voice Health Check', 'mlx_audio: false', 'voice-health-check');
    expect(secureIo.safeExec).toHaveBeenCalledWith('osascript', [
      '-e',
      'display notification "mlx_audio: false" with title "Voice Health Check" subtitle "voice-health-check"',
    ]);
  });
});
