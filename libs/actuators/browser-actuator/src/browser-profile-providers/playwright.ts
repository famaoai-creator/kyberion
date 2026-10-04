import { listPlaywrightProfiles, type BrowserProfile } from '../browser-profile-manager.js';
import type { BrowserProfileProviderModule } from '../browser-profile-provider-registry.js';

export const browserProfileProvider: BrowserProfileProviderModule = {
  listProfiles(options = {}) {
    return listPlaywrightProfiles(options.customPlaywrightDir);
  },
  async openProfile(profile: BrowserProfile, url: string, print: (message: string) => void) {
    print(
      '[browser-cli] Opening ' +
        url +
        ' with Playwright profile (' +
        profile.name +
        ' at ' +
        profile.userDataDir +
        ')...'
    );
    try {
      const playwright = await import('@playwright/test');
      const engineName = String(profile.metadata?.engine || 'chromium');
      const engine = (
        playwright as unknown as Record<
          string,
          {
            launchPersistentContext?: (
              userDataDir: string,
              options: { headless: boolean }
            ) => Promise<any>;
          }
        >
      )[engineName];
      if (!engine?.launchPersistentContext)
        throw new Error('Unsupported Playwright browser engine: ' + engineName);
      const context = await engine.launchPersistentContext(profile.userDataDir, {
        headless: false,
      });
      const page = context.pages()[0] || (await context.newPage());
      await page.goto(url);
      print('[browser-cli] URL opened in Playwright browser session.');
    } catch (err: any) {
      throw new Error('Failed to launch Playwright with profile: ' + err.message);
    }
  },
};
