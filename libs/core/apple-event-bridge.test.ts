import { describe, expect, it, vi } from 'vitest';

vi.mock('./secure-io.js', () => ({
  safeExec: vi.fn(() => ''),
}));

describe('apple-event-bridge', () => {
  it('detects the focused input as structured state', async () => {
    const secureIo = await import('./secure-io.js');
    vi.mocked(secureIo.safeExec).mockReturnValueOnce('Codex\nCurrent Chat\nAXTextArea\nChat Input\ntrue');
    const bridge = await import('./apple-event-bridge.js');

    expect(bridge.detectFocusedInput()).toEqual({
      application: 'Codex',
      windowTitle: 'Current Chat',
      role: 'AXTextArea',
      description: 'Chat Input',
      editable: true,
    });
  });

  it('builds an activate application AppleScript call', async () => {
    const secureIo = await import('./secure-io.js');
    const bridge = await import('./apple-event-bridge.js');

    bridge.activateApplication('Safari');

    expect(secureIo.safeExec).toHaveBeenCalledWith('osascript', ['-e', 'tell application "Safari" to activate']);
  });
});
