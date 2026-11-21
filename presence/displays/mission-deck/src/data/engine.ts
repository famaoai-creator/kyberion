/**
 * The data engine: a refresh loop + request handler. It is transport-free so
 * the same code runs inside the worker thread (production) and inline
 * (tests, and as a fallback when a worker cannot start).
 */
import type { SupportedLocale } from '@agent/core/locale';
import { runEffect, type EffectDeps, defaultEffectDeps } from '../actions/effects.js';
import { EMPTY_SNAPSHOT, type DeckSnapshot } from '../model/types.js';
import { defaultLoaderDeps, loadMissionDetail, loadSnapshot, type LoaderDeps } from './loaders.js';
import type { HostRequest, HostResponseValue } from './protocol.js';

export interface EngineOptions {
  locale?: SupportedLocale;
  intervalMs?: number;
  includeAgents?: boolean;
  loaderDeps?: LoaderDeps;
  effectDeps?: EffectDeps;
  detail?: typeof loadMissionDetail;
}

export class DeckEngine {
  private timer: ReturnType<typeof setInterval> | undefined;
  private loading = false;
  private last: DeckSnapshot = EMPTY_SNAPSHOT;

  constructor(
    private readonly emit: (snapshot: DeckSnapshot) => void,
    private options: EngineOptions = {}
  ) {}

  configure(options: Partial<EngineOptions>): void {
    this.options = { ...this.options, ...options };
    if (this.timer) {
      this.stop();
      this.start();
    }
  }

  start(): void {
    this.refresh();
    const interval = this.options.intervalMs ?? 2000;
    this.timer = setInterval(() => this.refresh(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Coalesces: a refresh requested while one is running is dropped. */
  refresh(): void {
    if (this.loading) return;
    this.loading = true;
    try {
      this.last = loadSnapshot(
        { locale: this.options.locale, includeAgents: this.options.includeAgents },
        this.options.loaderDeps ?? defaultLoaderDeps
      );
    } catch (err) {
      // Keep the last good data on screen and say that it is stale.
      this.last = {
        ...this.last,
        health: [
          ...this.last.health.filter((h) => h.source !== 'engine'),
          { source: 'engine', ok: false, detail: err instanceof Error ? err.message : String(err) },
        ],
      };
    } finally {
      this.emit(this.last);
      this.loading = false;
    }
  }

  snapshot(): DeckSnapshot {
    return this.last;
  }

  async handle(request: HostRequest): Promise<HostResponseValue> {
    if (request.op === 'missionDetail') {
      return (this.options.detail ?? loadMissionDetail)(request.id, request.row);
    }
    const result = await runEffect(request, this.options.effectDeps ?? defaultEffectDeps);
    // Effects change state: refresh right away rather than waiting a tick.
    setTimeout(() => this.refresh(), 50).unref?.();
    return result;
  }
}
