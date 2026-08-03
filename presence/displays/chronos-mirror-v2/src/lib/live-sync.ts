function areEquivalent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => areEquivalent(item, right[index]))
    );
  }
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && areEquivalent(leftRecord[key], rightRecord[key])
    )
  );
}

function retainEquivalent<T>(previous: T | undefined, next: T): T {
  return previous !== undefined && areEquivalent(previous, next) ? previous : next;
}

export interface LiveSyncSchedulerOptions<T> {
  fetchSnapshot: () => Promise<T>;
  onSnapshot: (snapshot: T) => void;
  debounceMs?: number;
  backgroundMs?: number;
  isVisible?: () => boolean;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * CE-01: events invalidate a read model; REST remains the source of truth.
 * Concurrent invalidations collapse into one fetch and equivalent snapshots
 * retain the previous object identity so expensive React subtrees do not
 * rebuild under an event burst.
 */
export class LiveSyncScheduler<T> {
  private current: T | undefined;
  private inFlight = false;
  private queued = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private backgroundTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly debounceMs: number;
  private readonly backgroundMs: number;
  private readonly schedule: (
    callback: () => void,
    delayMs: number
  ) => ReturnType<typeof setTimeout>;
  private readonly cancel: (handle: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly options: LiveSyncSchedulerOptions<T>) {
    this.debounceMs = options.debounceMs ?? 120;
    this.backgroundMs = options.backgroundMs ?? 5_000;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle));
  }

  invalidate(): void {
    if (this.stopped) return;
    this.queued = true;
    if (this.timer) this.cancel(this.timer);
    this.timer = this.schedule(() => {
      this.timer = undefined;
      void this.refresh();
    }, this.debounceMs);
  }

  async refresh(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    if (this.options.isVisible && !this.options.isVisible()) {
      this.queued = true;
      return;
    }
    this.inFlight = true;
    this.queued = false;
    try {
      const next = await this.options.fetchSnapshot();
      const stable = retainEquivalent(this.current, next);
      if (!this.current || !areEquivalent(this.current, next)) this.options.onSnapshot(stable);
      this.current = stable;
    } finally {
      this.inFlight = false;
      if (this.queued) this.invalidate();
    }
  }

  start(): void {
    this.stopped = false;
    this.invalidate();
    const tick = () => {
      if (this.stopped) return;
      if (!this.options.isVisible || this.options.isVisible()) void this.refresh();
      this.backgroundTimer = this.schedule(tick, this.backgroundMs);
    };
    this.backgroundTimer = this.schedule(tick, this.backgroundMs);
  }

  resume(): void {
    this.queued = true;
    this.invalidate();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.cancel(this.timer);
    if (this.backgroundTimer) this.cancel(this.backgroundTimer);
    this.timer = undefined;
    this.backgroundTimer = undefined;
  }

  get snapshot(): T | undefined {
    return this.current;
  }
}

export function bindVisibilityToLiveSync<T>(scheduler: LiveSyncScheduler<T>): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const onVisibility = () => {
    if (document.visibilityState === 'visible') scheduler.resume();
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => document.removeEventListener('visibilitychange', onVisibility);
}
