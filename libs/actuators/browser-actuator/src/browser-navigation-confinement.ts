import type { BrowserContext } from '@playwright/test';

export const ISOLATED_NAVIGATION_CAPABILITY = 'isolated-public-read-v1';
const contexts = new WeakMap<BrowserContext, { origin?: string }>();
const freshProfiles = new Set<string>();
/** Called with the result of canonical createScratchWorkspace by the pipeline. */
export function registerIsolatedBrowserProfile(profile: string): void {
  freshProfiles.add(profile);
}
export function claimIsolatedBrowserProfile(profile: string): boolean {
  return freshProfiles.delete(profile);
}

/** Called only by the owned fresh-profile factory, before creating any page.
 * Redirects are fetched with maxRedirects=0 and rejected before the browser
 * can follow them; routing alone would not guarantee redirect confinement. */
export async function installIsolatedNavigationConfinement(context: BrowserContext): Promise<void> {
  const policy: { origin?: string } = {};
  await context.route('**/*', async (route) => {
    const request = route.request();
    let permitted = false;
    try {
      const url = new URL(request.url());
      permitted = Boolean(
        policy.origin &&
        url.protocol === 'https:' &&
        url.origin === policy.origin &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        ['GET', 'HEAD'].includes(request.method())
      );
    } catch {
      /* denied */
    }
    if (!permitted) {
      await route.abort('blockedbyclient');
      return;
    }
    try {
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
      if (response.status() >= 300 && response.status() < 400) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          'content-security-policy':
            "default-src 'self' data:; script-src 'none'; connect-src 'none'; worker-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'",
        },
      });
    } catch {
      await route.abort('failed');
    }
  });
  contexts.set(context, policy);
}
export function hasIsolatedNavigationConfinement(context: BrowserContext): boolean {
  return contexts.has(context);
}
export function forgetIsolatedNavigationConfinement(context: BrowserContext): void {
  contexts.delete(context);
}
/** Invoked inside the shared gate's execute callback, after actual admission. */
export function permitIsolatedNavigation(context: BrowserContext, url: string): void {
  const policy = contexts.get(context);
  if (!policy) return;
  const target = new URL(url);
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error(
      '[BROWSER_ISOLATED_NAVIGATION_TARGET] HTTPS public navigation without query or fragment required'
    );
  policy.origin = target.origin;
}
