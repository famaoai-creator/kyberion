/**
 * Playwright Chromium provider for the browser-automation-runtime seam.
 */

import { chromium } from '@playwright/test';
import {
  registerBrowserAutomationRuntimeBridge,
  type BrowserAutomationLaunchPersistentContextOptions,
} from '@agent/core/browser-automation-runtime-bridge';

let registered = false;

export function registerPlaywrightBrowserAutomationRuntime(): void {
  if (registered) return;
  registered = true;
  registerBrowserAutomationRuntimeBridge({
    bridge_id: 'playwright-chromium',
    connectOverCDP(endpoint) {
      return chromium.connectOverCDP(endpoint);
    },
    launchPersistentContext(userDataDir, options: BrowserAutomationLaunchPersistentContextOptions) {
      return chromium.launchPersistentContext(userDataDir, {
        channel: options.channel === 'chrome' ? 'chrome' : undefined,
        headless: options.headless,
        viewport: options.viewport,
        locale: options.locale,
        recordVideo: options.recordVideo,
        args: options.args,
      });
    },
  });
}

registerPlaywrightBrowserAutomationRuntime();
