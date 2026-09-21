import { describe, expect, it } from 'vitest';
import {
  getBrowserAutomationRuntimeCapabilities,
  listBrowserAutomationRuntimeBridges,
  resolveBrowserAutomationRuntime,
} from '@agent/core/browser-automation-runtime-bridge';
import './browser-automation-runtime-playwright.js';
import { LIGHTPANDA_BRIDGE_ID } from './browser-automation-runtime-lightpanda.js';

describe('lightpanda browser-automation-runtime provider', () => {
  it('registers as an opt-in provider next to playwright-chromium', () => {
    const ids = listBrowserAutomationRuntimeBridges().map((bridge) => bridge.bridge_id);
    expect(ids).toEqual(expect.arrayContaining([LIGHTPANDA_BRIDGE_ID, 'playwright-chromium']));
    expect(resolveBrowserAutomationRuntime().bridge_id).toBe('playwright-chromium');
    const lightpanda = resolveBrowserAutomationRuntime(LIGHTPANDA_BRIDGE_ID);
    expect(getBrowserAutomationRuntimeCapabilities(lightpanda)).toMatchObject({
      multi_tab: false,
      pixel_screenshots: false,
      webauthn: false,
      attach_existing_browser: false,
    });
  });

  it('refuses to attach to an existing browser', async () => {
    await expect(
      resolveBrowserAutomationRuntime(LIGHTPANDA_BRIDGE_ID).connectOverCDP('http://127.0.0.1:9222')
    ).rejects.toThrow(/not supported/);
  });
});
