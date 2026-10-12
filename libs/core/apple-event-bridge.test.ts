import { describe, expect, it, vi } from 'vitest';

vi.mock('./secure-io.js', () => ({
  safeExec: vi.fn(() => ''),
  safeExecResult: vi.fn(() => ({ stdout: '', stderr: '', status: 0 })),
}));

const originalPlatform = process.platform;

function mockDarwinPlatform() {
  Object.defineProperty(process, 'platform', {
    value: 'darwin',
    configurable: true,
  });
}

function restorePlatform() {
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
  });
}

describe('apple-event-bridge', () => {
  it('detects the focused input as structured state', async () => {
    mockDarwinPlatform();
    const secureIo = await import('./secure-io.js');
    vi.mocked(secureIo.safeExec).mockReturnValueOnce(
      'Codex\nCurrent Chat\nAXTextArea\nChat Input\ntrue'
    );
    const bridge = await import('./apple-event-bridge.js');

    expect(bridge.detectFocusedInput()).toEqual({
      application: 'Codex',
      windowTitle: 'Current Chat',
      role: 'AXTextArea',
      description: 'Chat Input',
      editable: true,
    });

    restorePlatform();
  });

  it('builds an activate application AppleScript call', async () => {
    mockDarwinPlatform();
    const secureIo = await import('./secure-io.js');
    const bridge = await import('./apple-event-bridge.js');

    bridge.activateApplication('Safari');

    expect(secureIo.safeExec).toHaveBeenCalledWith('osascript', [
      '-e',
      'tell application "Safari" to activate',
    ]);

    restorePlatform();
  });

  it('launches an application through the native launch boundary', async () => {
    mockDarwinPlatform();
    const secureIo = await import('./secure-io.js');
    const bridge = await import('./apple-event-bridge.js');

    expect(bridge.launchApplication('Safari')).toBe(true);
    expect(secureIo.safeExecResult).toHaveBeenCalledWith('open', ['-a', 'Safari'], {
      timeoutMs: 10_000,
    });
    restorePlatform();
  });

  it('sets window state through Accessibility actions with explicit matching', async () => {
    mockDarwinPlatform();
    const secureIo = await import('./secure-io.js');
    vi.mocked(secureIo.safeExec).mockReturnValueOnce('true');
    const bridge = await import('./apple-event-bridge.js');

    expect(bridge.setWindowState('Safari', 'Settings', 'maximize', 'strict')).toBe(true);
    const script = vi.mocked(secureIo.safeExec).mock.calls.at(-1)?.[1]?.[1];
    expect(script).toContain('name of w is "Settings"');
    expect(script).toContain('perform action "AXZoom" of w');
    restorePlatform();
  });

  it('toggles dictation using the macOS key code helper', async () => {
    mockDarwinPlatform();
    const secureIo = await import('./secure-io.js');
    const bridge = await import('./apple-event-bridge.js');

    bridge.toggleDictation(176);

    expect(secureIo.safeExec).toHaveBeenCalledWith('osascript', [
      '-e',
      'tell application "System Events" to key code 176',
    ]);

    restorePlatform();
  });

  it('builds a system notification AppleScript call', async () => {
    mockDarwinPlatform();
    const secureIo = await import('./secure-io.js');
    vi.mocked(secureIo.safeExec).mockReturnValue('');
    const bridge = await import('./apple-event-bridge.js');

    bridge.systemNotify('Voice Health Check', 'mlx_audio: false', 'voice-health-check');
    expect(secureIo.safeExec).toHaveBeenCalledWith('osascript', [
      '-e',
      'display notification "mlx_audio: false" with title "Voice Health Check" subtitle "voice-health-check"',
    ]);

    restorePlatform();
  });
});
