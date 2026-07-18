import { buildGovernedRetryOptions, classifyError, safeReadFile, pathResolver } from '@agent/core';

const MEETING_BROWSER_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/meeting-browser-driver/manifest.json'
);
const DEFAULT_MEETING_BROWSER_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  factor: 2,
  jitter: true,
};

function buildRetryOptions(override?: Record<string, any>) {
  return buildGovernedRetryOptions({
    manifestPath: MEETING_BROWSER_MANIFEST_PATH,
    defaults: DEFAULT_MEETING_BROWSER_RETRY,
    override: override,
    fallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
  });
}

async function loadPlaywright(): Promise<any> {
  return new Function('specifier', 'return import(specifier)')('playwright');
}

async function trySelectors(
  page: { isVisible: (selector: string) => Promise<boolean> },
  selectors: string[],
  action: (selector: string) => Promise<void>
): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const visible = await page.isVisible(sel).catch(() => false);
      if (!visible) continue;
      await action(sel);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

async function waitForAnyVisibleSelector(
  page: { isVisible: (selector: string) => Promise<boolean> },
  selectors: string[],
  opts: { timeoutMs: number; pollMs?: number }
): Promise<string | null> {
  const pollMs = opts.pollMs ?? 500;
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        if (await page.isVisible(sel).catch(() => false)) return sel;
      } catch {
        /* try next */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

export {
  buildRetryOptions,
  loadPlaywright,
  trySelectors,
  waitForAnyVisibleSelector,
  DEFAULT_MEETING_BROWSER_RETRY,
};
