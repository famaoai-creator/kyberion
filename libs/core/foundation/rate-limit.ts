/** Framework-neutral fixed windows. HTTP adapters alone convert milliseconds to seconds. */
import { BlockList, isIP } from 'node:net';

export type FixedWindowDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export interface FixedWindowOptions {
  windowMs: number;
  maxKeys: number;
  eviction: 'lru' | 'fifo' | 'deny';
  /** Legacy adapters with `elapsed > window` retain their exact boundary. */
  expireAtBoundary?: boolean;
  now?: () => number;
}

/** Separate instances isolate callers with different retention or authority boundaries. */
export function fixedWindowLimiter(options: FixedWindowOptions) {
  if (
    !Number.isFinite(options.windowMs) ||
    options.windowMs <= 0 ||
    !Number.isSafeInteger(options.maxKeys) ||
    options.maxKeys < 1
  ) {
    throw new Error('Fixed window requires positive windowMs and maxKeys');
  }
  const buckets = new Map<string, { start: number; count: number; windowMs: number }>();
  const expired = (start: number, now: number, windowMs: number): boolean =>
    options.expireAtBoundary === false ? now - start > windowMs : now - start >= windowMs;
  return {
    take(
      key: string,
      limit: number,
      now = (options.now ?? Date.now)(),
      windowMs = options.windowMs
    ): FixedWindowDecision {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 0 ||
        !Number.isFinite(now) ||
        !Number.isFinite(windowMs) ||
        windowMs <= 0
      ) {
        throw new Error(
          'Fixed window requires a nonnegative integer limit, positive window and finite clock'
        );
      }
      let bucket = buckets.get(key);
      if (bucket && expired(bucket.start, now, windowMs)) {
        buckets.delete(key);
        bucket = undefined;
      }
      if (!bucket) {
        if (buckets.size >= options.maxKeys) {
          for (const [candidate, value] of buckets) {
            if (expired(value.start, now, value.windowMs)) buckets.delete(candidate);
          }
          if (buckets.size >= options.maxKeys) {
            if (options.eviction === 'deny') {
              let earliest = Infinity;
              for (const value of buckets.values()) {
                earliest = Math.min(earliest, value.start + value.windowMs - now);
              }
              return { allowed: false, retryAfterMs: Math.max(1, earliest) };
            }
            const oldest = buckets.keys().next().value;
            if (oldest !== undefined) buckets.delete(oldest);
          }
        }
        bucket = { start: now, count: 0, windowMs };
        buckets.set(key, bucket);
      } else if (options.eviction === 'lru') {
        buckets.delete(key);
        buckets.set(key, bucket);
      }
      bucket.windowMs = windowMs;
      // Saturate: unlimited denied requests cannot overflow the counter.
      bucket.count = Math.min(bucket.count + 1, Number.MAX_SAFE_INTEGER);
      return bucket.count <= limit
        ? { allowed: true }
        : { allowed: false, retryAfterMs: Math.max(1, windowMs - (now - bucket.start)) };
    },
    clear(): void {
      buckets.clear();
    },
    forget(key: string): void {
      buckets.delete(key);
    },
    retryAfterMs(key: string, now = (options.now ?? Date.now)()): number | undefined {
      const bucket = buckets.get(key);
      return bucket && !expired(bucket.start, now, bucket.windowMs)
        ? Math.max(1, bucket.windowMs - (now - bucket.start))
        : undefined;
    },
    get size(): number {
      return buckets.size;
    },
  };
}

/**
 * Trusted-proxy client keying for per-address limits. An HTTP surface behind a
 * reverse proxy (public ingress) sees every request from the proxy's address;
 * keying limits on it would put every caller in one bucket. The forwarded
 * headers name the real caller, but any client can send them, so they are only
 * read when the direct peer is an operator-declared proxy, and only the hops
 * those proxies appended (walking from the right) are believed.
 */
export interface TrustedProxies {
  /** Whether `address` (an IP literal) belongs to a declared proxy. */
  has(address: string): boolean;
  /** Number of declared entries (zero trusts nobody). */
  readonly size: number;
}

/** Most hops read from a forwarded chain; beyond it the client is unknown. */
export const MAX_FORWARDED_HOPS = 32;

const IPV4_WITH_PORT = /^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/u;
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu;

/**
 * An IP literal, or null. Accepts the forms proxies write (`[v6]`, `[v6]:port`,
 * `v4:port`, a v6 zone), unwraps IPv4-mapped IPv6 and lowercases IPv6.
 */
export function normalizeIpAddress(raw: string | undefined | null): string | null {
  let value = (raw ?? '').trim();
  if (!value || value.length > 64) return null;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return null;
    const rest = value.slice(end + 1);
    if (rest && !/^:\d{1,5}$/u.test(rest)) return null;
    value = value.slice(1, end);
    if (isIP(value.split('%')[0] ?? '') !== 6) return null;
  } else if (IPV4_WITH_PORT.test(value)) {
    value = value.slice(0, value.lastIndexOf(':'));
  }
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  const mapped = IPV4_MAPPED.exec(value);
  if (mapped?.[1] && isIP(mapped[1]) === 4) return mapped[1];
  return value.toLowerCase();
}

/**
 * Parse an operator list of proxy IPs / CIDRs (comma or whitespace separated).
 * Invalid entries are returned so the caller can refuse to start rather than
 * trust something other than what the operator meant.
 */
export function parseTrustedProxies(raw: string | undefined | null): {
  proxies: TrustedProxies;
  invalid: string[];
} {
  const list = new BlockList();
  const invalid: string[] = [];
  let size = 0;
  for (const entry of (raw ?? '').split(/[\s,]+/u).filter(Boolean)) {
    const slash = entry.indexOf('/');
    const address = normalizeIpAddress(slash < 0 ? entry : entry.slice(0, slash));
    if (!address) {
      invalid.push(entry);
      continue;
    }
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (slash < 0) {
      list.addAddress(address, family);
    } else {
      const bits = entry.slice(slash + 1);
      const prefix = /^\d{1,3}$/u.test(bits) ? Number(bits) : Number.NaN;
      if (!(prefix >= 0 && prefix <= (family === 'ipv6' ? 128 : 32))) {
        invalid.push(entry);
        continue;
      }
      list.addSubnet(address, prefix, family);
    }
    size += 1;
  }
  return {
    proxies: {
      has(candidate: string): boolean {
        const address = normalizeIpAddress(candidate);
        if (!address || size === 0) return false;
        return list.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
      },
      size,
    },
    invalid,
  };
}

type HeaderValue = string | string[] | undefined | null;

function joinHeader(value: HeaderValue): string {
  return Array.isArray(value) ? value.join(',') : (value ?? '');
}

/** Split on commas outside double quotes (RFC 7239 values may be quoted). */
function splitList(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    if (char === ',' && !quoted) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** The `for=` node of one RFC 7239 element, unquoted; '' when it has none. */
function forwardedForNode(element: string): string {
  for (const pair of element.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0 || pair.slice(0, eq).trim().toLowerCase() !== 'for') continue;
    const value = pair.slice(eq + 1).trim();
    return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
      ? value.slice(1, -1)
      : value;
  }
  return '';
}

/**
 * The address to key per-client limits on. Unless the direct peer is a
 * declared proxy, the peer is the answer and forwarded headers are ignored.
 * Behind a declared proxy the chain is walked from the right: the first hop
 * that is not itself a declared proxy is the client. `X-Forwarded-For` wins
 * over `Forwarded` when both are present. A malformed, obfuscated (`unknown`,
 * `_hidden`) or overlong chain stops the walk at the nearest trusted address,
 * so a bad chain shares its proxy's bucket instead of naming an arbitrary key.
 */
export function resolveClientAddress(input: {
  peer: string | undefined | null;
  forwardedFor?: HeaderValue;
  forwarded?: HeaderValue;
  trustedProxies: TrustedProxies;
}): string {
  const peer = normalizeIpAddress(input.peer) ?? (input.peer?.trim() || 'unknown');
  if (input.trustedProxies.size === 0 || !input.trustedProxies.has(peer)) return peer;
  const xff = joinHeader(input.forwardedFor);
  const hops = xff.trim()
    ? splitList(xff)
    : splitList(joinHeader(input.forwarded)).map(forwardedForNode);
  let client = peer;
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    if (hops.length - index > MAX_FORWARDED_HOPS) return client;
    const hop = normalizeIpAddress(hops[index]);
    if (!hop) return client;
    client = hop;
    if (!input.trustedProxies.has(hop)) return hop;
  }
  return client;
}
