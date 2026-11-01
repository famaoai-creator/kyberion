import type { BrowserRuntime } from './browser-runtime-types.js';
import { getOrCreatePageCdpSession } from './browser-passkey-helpers.js';

/**
 * Governed raw-CDP escape lane (`cdp` op), adopted from browser-use's
 * `cdp(method, ...)` helper. It exists for what the Playwright surface cannot
 * reach — DOMSnapshot across cross-origin iframes, paint-order/occlusion
 * geometry, the full AX tree — while staying inside page scope.
 *
 * The boundary is the domain, not the method: anything scoped at or below the
 * page (DOM, DOMSnapshot, Accessibility, Page, Runtime, Input, …) is no more
 * powerful than the already-ungated `evaluate` op, so it is allowed; domains
 * that reach outside page scope — other targets, the browser process,
 * network interception, storage, CSP bypass — are refused fail-closed, as are
 * the specific page-level methods that would widen the boundary.
 */

export const CDP_ALLOWED_DOMAINS: ReadonlySet<string> = new Set([
  'Accessibility',
  'Animation',
  'CSS',
  'Console',
  'DOM',
  'DOMDebugger',
  'DOMSnapshot',
  'Input',
  'Log',
  'Media',
  'Overlay',
  'Page',
  'Performance',
  'Runtime',
]);

/** Page-scoped methods that still widen the boundary. */
export const CDP_DENIED_METHODS: ReadonlySet<string> = new Set([
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.removeScriptToEvaluateOnNewDocument',
  'Page.setBypassCSP',
  'Page.setInterceptFileChooserDialog',
  'Runtime.addBinding',
  'Runtime.removeBinding',
]);

export class BrowserCdpError extends Error {
  readonly code: 'CDP_DOMAIN_DENIED' | 'CDP_METHOD_DENIED' | 'CDP_TIMEOUT' | 'CDP_CALL_FAILED';
  constructor(code: BrowserCdpError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'BrowserCdpError';
  }
}

export function parseCdpMethodName(method: unknown): { domain: string; command: string } {
  if (typeof method !== 'string' || !method.includes('.')) {
    throw new BrowserCdpError(
      'CDP_DOMAIN_DENIED',
      'cdp op requires method in "<Domain>.<command>" form (e.g. "DOMSnapshot.captureSnapshot")'
    );
  }
  const [domain, command] = method.split('.', 2);
  if (!domain || !command) {
    throw new BrowserCdpError(
      'CDP_DOMAIN_DENIED',
      `cdp method "${method}" is malformed; expected "<Domain>.<command>"`
    );
  }
  return { domain, command };
}

export function assertCdpMethodAllowed(method: string): void {
  const { domain } = parseCdpMethodName(method);
  if (!CDP_ALLOWED_DOMAINS.has(domain)) {
    throw new BrowserCdpError(
      'CDP_DOMAIN_DENIED',
      `cdp domain "${domain}" is outside page scope; allowed domains: ${[...CDP_ALLOWED_DOMAINS].sort().join(', ')}`
    );
  }
  if (CDP_DENIED_METHODS.has(method)) {
    throw new BrowserCdpError(
      'CDP_METHOD_DENIED',
      `cdp method "${method}" would widen the session boundary and is refused`
    );
  }
}

const DEFAULT_CDP_TIMEOUT_MS = 10_000;
const MAX_CDP_TIMEOUT_MS = 60_000;

export function resolveCdpTimeoutMs(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CDP_TIMEOUT_MS;
  return Math.min(Math.floor(parsed), MAX_CDP_TIMEOUT_MS);
}

export async function executeBrowserCdp(
  runtime: BrowserRuntime,
  page: Parameters<typeof getOrCreatePageCdpSession>[1],
  method: string,
  params: Record<string, unknown> | undefined,
  timeoutMs?: number
): Promise<unknown> {
  assertCdpMethodAllowed(method);
  const budget = resolveCdpTimeoutMs(timeoutMs);
  const session = await getOrCreatePageCdpSession(runtime, page);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      session.send(method as never, params as never),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new BrowserCdpError('CDP_TIMEOUT', `cdp ${method} did not answer within ${budget}ms`)
            ),
          budget
        );
      }),
    ]);
  } catch (error: unknown) {
    if (error instanceof BrowserCdpError) throw error;
    throw new BrowserCdpError(
      'CDP_CALL_FAILED',
      `cdp ${method} failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
