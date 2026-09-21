import { afterEach, describe, expect, it } from 'vitest';
import {
  FULL_BROWSER_AUTOMATION_RUNTIME_CAPABILITIES,
  getBrowserAutomationRuntimeCapabilities,
  registerBrowserAutomationRuntimeBridge,
  resetBrowserAutomationRuntimeBridges,
  resolveBrowserAutomationRuntime,
  type BrowserAutomationRuntimeBridge,
} from './browser-automation-runtime-bridge.js';

function bridge(
  id: string,
  capabilities?: BrowserAutomationRuntimeBridge['capabilities']
): BrowserAutomationRuntimeBridge {
  return {
    bridge_id: id,
    capabilities,
    connectOverCDP: async () => ({}),
    launchPersistentContext: async () => ({}),
  };
}

const RESTRICTED = {
  ...FULL_BROWSER_AUTOMATION_RUNTIME_CAPABILITIES,
  multi_tab: false,
  pixel_screenshots: false,
};

describe('browser-automation-runtime bridge', () => {
  afterEach(() => resetBrowserAutomationRuntimeBridges());

  it('never auto-selects a capability-restricted provider', () => {
    registerBrowserAutomationRuntimeBridge(bridge('a-restricted', RESTRICTED));
    registerBrowserAutomationRuntimeBridge(bridge('z-full'));
    expect(resolveBrowserAutomationRuntime().bridge_id).toBe('z-full');
    expect(resolveBrowserAutomationRuntime('auto').bridge_id).toBe('z-full');
  });

  it('selects a restricted provider when requested by id', () => {
    registerBrowserAutomationRuntimeBridge(bridge('a-restricted', RESTRICTED));
    registerBrowserAutomationRuntimeBridge(bridge('z-full'));
    expect(resolveBrowserAutomationRuntime('a-restricted').bridge_id).toBe('a-restricted');
    expect(() => resolveBrowserAutomationRuntime('missing')).toThrow(/not registered/);
  });

  it('treats omitted capabilities as full Chromium-equivalent', () => {
    expect(getBrowserAutomationRuntimeCapabilities(bridge('full'))).toEqual(
      FULL_BROWSER_AUTOMATION_RUNTIME_CAPABILITIES
    );
    expect(getBrowserAutomationRuntimeCapabilities(bridge('r', RESTRICTED)).multi_tab).toBe(false);
  });
});
