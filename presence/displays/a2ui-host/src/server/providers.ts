/**
 * Providers — the producers this host may talk to.
 *
 * The browser never calls a producer directly: every request goes through
 * the host's proxy, and the proxy only forwards to providers listed here.
 * Providers come from `KYBERION_A2UI_HOST_PROVIDERS` (`id=base_url,...`),
 * falling back to the local surfaces that already publish A2UI. Only
 * loopback HTTP(S) bases are accepted so the host cannot be pointed at the
 * open internet by a stray environment value.
 */

export interface A2UIProvider {
  id: string;
  baseUrl: string;
}

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/u;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const DEFAULT_PROVIDERS: readonly A2UIProvider[] = [
  { id: 'presence-studio', baseUrl: 'http://127.0.0.1:3031' },
  { id: 'computer-surface', baseUrl: 'http://127.0.0.1:3040' },
];

/** Accept `http(s)://<loopback host>[:port]` without path, query or fragment. */
export function isAllowedProviderBase(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (!LOOPBACK_HOSTS.has(url.hostname === '::1' ? '[::1]' : url.hostname)) return false;
  if (url.username || url.password || url.search || url.hash) return false;
  return url.pathname === '/' || url.pathname === '';
}

/**
 * Parse `id=base_url` pairs separated by commas. Invalid pairs are skipped
 * and reported through `onSkip`; an empty or missing value yields the
 * defaults. Duplicate ids keep the first occurrence.
 */
export function parseProviders(
  text: string | undefined,
  onSkip: (pair: string, reason: string) => void = () => {}
): A2UIProvider[] {
  if (!text || !text.trim()) return DEFAULT_PROVIDERS.map((provider) => ({ ...provider }));
  const seen = new Set<string>();
  const providers: A2UIProvider[] = [];
  for (const rawPair of text.split(',')) {
    const pair = rawPair.trim();
    if (!pair) continue;
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      onSkip(pair, 'expected id=base_url');
      continue;
    }
    const id = pair.slice(0, separator).trim();
    const baseUrl = pair
      .slice(separator + 1)
      .trim()
      .replace(/\/+$/u, '');
    if (!PROVIDER_ID_PATTERN.test(id)) {
      onSkip(pair, 'invalid provider id');
      continue;
    }
    if (!isAllowedProviderBase(baseUrl)) {
      onSkip(pair, 'base url must be a loopback http(s) origin');
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    providers.push({ id, baseUrl });
  }
  return providers;
}

export function findProvider(
  providers: readonly A2UIProvider[],
  id: unknown
): A2UIProvider | undefined {
  if (typeof id !== 'string' || !PROVIDER_ID_PATTERN.test(id)) return undefined;
  return providers.find((provider) => provider.id === id);
}
