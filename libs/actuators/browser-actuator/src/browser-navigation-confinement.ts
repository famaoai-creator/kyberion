import type { BrowserContext } from '@playwright/test';

export const ISOLATED_NAVIGATION_CAPABILITY = 'isolated-public-read-v1';
export const AUTHENTICATED_ORIGIN_SET_CAPABILITY = 'authenticated-origin-set-v1';
/** Chromium switches that close egress paths the request router never sees
 * (preconnect, DNS, WebRTC, background services): names outside the declared
 * hosts do not resolve at all. */
export function authenticatedOriginLaunchArgs(declaredOrigins: readonly string[]): string[] {
  const hosts = [
    ...new Set(declaredOrigins.map((origin) => new URL(normalizeConfinedOrigin(origin)).hostname)),
  ];
  return [
    `--host-resolver-rules=MAP * ~NOTFOUND, ${hosts.map((host) => `EXCLUDE ${host}`).join(', ')}`,
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--dns-prefetch-disable',
    '--disable-background-networking',
  ];
}
const DISABLE_PEER_CONNECTIONS = `(() => {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) {
    try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false }); } catch {}
  }
})();`;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Not needed to read a list, and the router buffers every body in Node. */
const DROPPED_RESOURCE_TYPES = new Set(['media', 'font']);
const MAX_RECORDED_BLOCKED_HOSTS = 20;

export interface AuthenticatedConfinementState {
  origins: ReadonlySet<string>;
  /** Requests refused by the confinement, by host name only (never full URLs). */
  blocked: { count: number; hosts: Set<string> };
}
const authenticatedContexts = new WeakMap<BrowserContext, AuthenticatedConfinementState>();

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname || '(none)';
  } catch {
    return '(invalid)';
  }
}

/** Canonical `https://host[:port]` form; anything else is rejected. */
export function normalizeConfinedOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== value)
    throw new Error(`[BROWSER_CONFINEMENT_ORIGIN] Exact HTTPS origin required: ${value}`);
  return url.origin;
}

export function isConfinedOriginUrl(raw: string, origins: ReadonlySet<string>): boolean {
  try {
    const url = new URL(raw);
    const httpOrigin =
      url.protocol === 'wss:' ? `https://${url.host}` : url.protocol === 'https:' ? url.origin : '';
    return Boolean(httpOrigin) && !url.username && !url.password && origins.has(httpOrigin);
  } catch {
    return false;
  }
}

/** Called only by an owned fresh-profile factory, before creating any page.
 * Unlike the isolated public read, scripts and form posts run (login and
 * server postbacks need them), so every request, redirect hop and WebSocket
 * must stay inside the declared origin set. Redirects are fetched with
 * maxRedirects=0 and only an in-set Location is handed back to the browser. */
export async function installAuthenticatedOriginConfinement(
  context: BrowserContext,
  declaredOrigins: readonly string[]
): Promise<void> {
  if (declaredOrigins.length === 0)
    throw new Error('[BROWSER_CONFINEMENT_ORIGIN] At least one origin is required');
  const origins: ReadonlySet<string> = new Set(declaredOrigins.map(normalizeConfinedOrigin));
  const state: AuthenticatedConfinementState = { origins, blocked: { count: 0, hosts: new Set() } };
  const block = (raw: string) => {
    state.blocked.count += 1;
    if (state.blocked.hosts.size < MAX_RECORDED_BLOCKED_HOSTS) state.blocked.hosts.add(hostOf(raw));
  };
  await context.addInitScript(DISABLE_PEER_CONNECTIONS);
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    if (!url.startsWith('https:') || !isConfinedOriginUrl(url, origins)) {
      block(url);
      await route.abort('blockedbyclient');
      return;
    }
    if (DROPPED_RESOURCE_TYPES.has(request.resourceType())) {
      await route.abort('blockedbyclient');
      return;
    }
    try {
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
      if (REDIRECT_STATUSES.has(response.status())) {
        const location = response.headers()['location'];
        let next = '';
        try {
          next = location ? new URL(location, url).toString() : '';
        } catch {
          next = '';
        }
        if (!next.startsWith('https:') || !isConfinedOriginUrl(next, origins)) {
          block(next || url);
          await route.abort('blockedbyclient');
          return;
        }
      }
      await route.fulfill({ response });
    } catch {
      await route.abort('failed');
    }
  });
  await context.routeWebSocket(
    () => true,
    (ws) => {
      if (isConfinedOriginUrl(ws.url(), origins)) ws.connectToServer();
      else {
        block(ws.url());
        void ws.close({ code: 1008, reason: 'blocked by confinement' });
      }
    }
  );
  authenticatedContexts.set(context, state);
}

export function authenticatedConfinementOrigins(
  context: BrowserContext
): ReadonlySet<string> | undefined {
  return authenticatedContexts.get(context)?.origins;
}

export function authenticatedConfinementBlocks(context: BrowserContext): {
  count: number;
  hosts: string[];
} {
  const blocked = authenticatedContexts.get(context)?.blocked;
  return { count: blocked?.count ?? 0, hosts: [...(blocked?.hosts ?? [])].sort() };
}
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
