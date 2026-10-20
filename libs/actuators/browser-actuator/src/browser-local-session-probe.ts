import { chromium } from '@playwright/test';
import { assertSafeRepositoryPath, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import * as path from 'node:path';

const MARKUP =
  '<!doctype html><html><head><title>Kyberion First Win</title></head>' +
  '<body><h1>Kyberion First Win</h1>' +
  '<p>The browser runtime opened a page and captured this artifact.</p></body></html>';

// The catalog SDK forwards these standard runner fields to pipeline handlers.
// They carry no rendering inputs or authority for this fixed-content probe.
const INPUT_KEYS = new Set(['path', 'export_as', '_reasoning_policy', '_facets', '_step_id']);

/** A fixed offline rendering probe; never attaches to a caller's browser/profile. */
export async function runLocalSessionProbe(
  params: Record<string, unknown>,
  initialContext: Record<string, unknown>
) {
  if (
    Object.keys(params).some((key) => !INPUT_KEYS.has(key)) ||
    (params.export_as !== undefined &&
      (typeof params.export_as !== 'string' || !params.export_as.trim())) ||
    (params.path !== undefined && (typeof params.path !== 'string' || !params.path.trim())) ||
    (initialContext.TARGET_URL !== undefined && initialContext.TARGET_URL !== '')
  ) {
    throw new Error(
      '[BROWSER_LOCAL_PROBE_INPUT] Only a screenshot path is supported; use a governed browser navigation pipeline for TARGET_URL, HTML, or script.'
    );
  }
  const screenshotPath = assertSafeRepositoryPath(
    pathResolver.rootResolve(
      typeof params.path === 'string' ? params.path : 'active/shared/tmp/first-win-session.png'
    ),
    { allowMissingLeaf: true }
  );
  const scratchRoot = assertSafeRepositoryPath(pathResolver.shared('tmp'), {
    allowMissingLeaf: true,
  });
  const scratchRelative = path.relative(scratchRoot, screenshotPath);
  if (
    !scratchRelative ||
    scratchRelative.startsWith(`..${path.sep}`) ||
    scratchRelative === '..' ||
    path.isAbsolute(scratchRelative) ||
    path.extname(screenshotPath).toLowerCase() !== '.png'
  ) {
    throw new Error(
      '[BROWSER_LOCAL_PROBE_PATH] Screenshot output must be a PNG under active/shared/tmp.'
    );
  }
  safeMkdir(path.dirname(screenshotPath), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      offline: true,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    try {
      await context.route('**/*', (route) => route.abort());
      const page = await context.newPage();
      await page.setContent(MARKUP);
      const state = {
        title: await page.title(),
        url: page.url(),
        bodyText: (await page.innerText('body')).slice(0, 80),
      };
      const screenshot = await page.screenshot({ type: 'png' });
      safeWriteFile(screenshotPath, screenshot);
      return {
        status: 'success' as const,
        results: [
          {
            op: 'local_session_probe',
            status: 'success',
            output: { ...state, path: screenshotPath },
          },
        ],
        context: {
          ...initialContext,
          session_state: state,
          last_screenshot: screenshotPath,
          first_win_screenshot: { path: screenshotPath },
        },
        total_steps: 1,
      };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
