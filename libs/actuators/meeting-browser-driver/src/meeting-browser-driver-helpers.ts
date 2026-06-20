import { classifyError, safeReadFile, pathResolver, withRetry } from '@agent/core';

const MEETING_BROWSER_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/meeting-browser-driver/manifest.json');
const DEFAULT_MEETING_BROWSER_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  factor: 2,
  jitter: true,
};

let cachedRecoveryPolicy: Record<string, any> | undefined;

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadRecoveryPolicy(): Record<string, any> {
  if (cachedRecoveryPolicy) return cachedRecoveryPolicy;
  try {
    const manifest = JSON.parse(safeReadFile(MEETING_BROWSER_MANIFEST_PATH, { encoding: 'utf8' }) as string);
    cachedRecoveryPolicy = isPlainObject(manifest?.recovery_policy) ? manifest.recovery_policy : {};
    return cachedRecoveryPolicy ?? {};
  } catch (_) {
    cachedRecoveryPolicy = {};
    return cachedRecoveryPolicy ?? {};
  }
}

function buildRetryOptions(override?: Record<string, any>) {
  const recoveryPolicy = loadRecoveryPolicy();
  const manifestRetry = isPlainObject(recoveryPolicy.retry) ? recoveryPolicy.retry : {};
  const retryableCategories = new Set<string>(
    Array.isArray(recoveryPolicy.retryable_categories) ? recoveryPolicy.retryable_categories.map(String) : [],
  );
  const resolved = {
    ...DEFAULT_MEETING_BROWSER_RETRY,
    ...manifestRetry,
    ...(override || {}),
  };
  return {
    ...resolved,
    shouldRetry: (error: Error) => {
      const classification = classifyError(error);
      if (retryableCategories.size > 0) {
        return retryableCategories.has(classification.category);
      }
      return classification.category === 'network'
        || classification.category === 'rate_limit'
        || classification.category === 'timeout'
        || classification.category === 'resource_unavailable';
    },
  };
}

async function loadPlaywright(): Promise<any> {
  return new Function('specifier', 'return import(specifier)')('playwright');
}

async function trySelectors(
  page: { isVisible: (selector: string) => Promise<boolean> },
  selectors: string[],
  action: (selector: string) => Promise<void>,
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

export {
  buildRetryOptions,
  loadPlaywright,
  trySelectors,
  DEFAULT_MEETING_BROWSER_RETRY,
};

