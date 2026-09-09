import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('kyberion home playwright wiring', () => {
  const source = String(
    safeReadFile(pathResolver.rootResolve('scripts/kyberion_home.ts'), {
      encoding: 'utf8',
    })
  );

  it('injects the shared host-boundary Playwright executor instead of inlining handleAction', () => {
    expect(source).toContain("from './browser_playwright_executor.js'");
    expect(source).toContain('createExecuteBrowserPipeline');
    expect(source).toContain('loadBrowserActuator');
    expect(source).not.toContain('pathToFileURL(actuatorPath)');
    expect(source).not.toContain('connect_over_cdp: true');
  });

  it('allows standalone Playwright without requiring --tab-id', () => {
    expect(source).not.toContain("ui('recorder:recorder_browser_tab_required')");
  });

  it('does not treat --tab-id alone as a CDP attach signal', () => {
    expect(source).toContain('const connectOverCdp = Boolean(argv.cdpUrl || argv.cdpPort)');
    expect(source).not.toMatch(/connectOverCdp = Boolean\(tabId/);
  });
});
