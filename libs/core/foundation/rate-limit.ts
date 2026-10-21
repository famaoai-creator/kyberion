/** Framework-neutral fixed windows. HTTP adapters alone convert milliseconds to seconds. */
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
