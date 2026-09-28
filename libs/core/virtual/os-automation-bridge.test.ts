import { describe, expect, it } from 'vitest';
import { osAutomationBridge } from './os-automation-bridge.js';

describe('os-automation-bridge', () => {
  it('exposes the L0 desktop automation facade', () => {
    expect(typeof osAutomationBridge.activateApplication).toBe('function');
    expect(typeof osAutomationBridge.detectFocusedInput).toBe('function');
    expect(typeof osAutomationBridge.keystrokeText).toBe('function');
    expect(typeof osAutomationBridge.pasteText).toBe('function');
    expect(typeof osAutomationBridge.pressKey).toBe('function');
    expect(typeof osAutomationBridge.pressKeyCode).toBe('function');
    expect(typeof osAutomationBridge.toggleDictation).toBe('function');
    expect(typeof osAutomationBridge.clickAt).toBe('function');
    expect(typeof osAutomationBridge.moveMouse).toBe('function');
    expect(typeof osAutomationBridge.runAppleScript).toBe('function');
    expect(typeof osAutomationBridge.listKnownAppCapabilities).toBe('function');
    expect(typeof osAutomationBridge.listChromeTabs).toBe('function');
    expect(typeof osAutomationBridge.emptyFinderTrash).toBe('function');
  });
});
