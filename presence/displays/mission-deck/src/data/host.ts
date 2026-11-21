/**
 * Render-thread side of the data engine. `createWorkerHost` runs the engine
 * in a worker thread; `createInlineHost` runs it in-process (tests, fallback).
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { SupportedLocale } from '@agent/core/locale';
import { setOperatorBaseRole } from '../actions/effects.js';
import { DeckEngine, type EngineOptions } from './engine.js';
import type { DeckSnapshot } from '../model/types.js';
import type { FromWorker, HostRequest, HostResponseValue, ToWorker } from './protocol.js';

export interface DeckHost {
  subscribe(listener: (snapshot: DeckSnapshot) => void): () => void;
  request(request: HostRequest): Promise<HostResponseValue>;
  refresh(): void;
  /** Switches the language of loader-built text (the worker has its own copy). */
  setLocale(locale: SupportedLocale): void;
  stop(): void;
  readonly mode: 'worker' | 'inline';
}

export interface HostOptions {
  locale?: SupportedLocale;
  intervalMs?: number;
  includeAgents?: boolean;
  /** Base role for child processes; see setOperatorBaseRole. */
  operatorBaseRole?: string;
}

class Listeners {
  private set = new Set<(snapshot: DeckSnapshot) => void>();
  last: DeckSnapshot | undefined;
  add(listener: (snapshot: DeckSnapshot) => void): () => void {
    this.set.add(listener);
    if (this.last) listener(this.last);
    return () => this.set.delete(listener);
  }
  emit(snapshot: DeckSnapshot): void {
    this.last = snapshot;
    for (const listener of this.set) listener(snapshot);
  }
}

export function createInlineHost(options: HostOptions & EngineOptions = {}): DeckHost {
  const listeners = new Listeners();
  if ('operatorBaseRole' in options) setOperatorBaseRole(options.operatorBaseRole);
  const engine = new DeckEngine((snapshot) => listeners.emit(snapshot), options);
  // Defer the first (synchronous) load so subscribers attach first.
  const startTimer = setTimeout(() => engine.start(), 0);
  return {
    mode: 'inline',
    subscribe: (listener) => listeners.add(listener),
    request: (request) => engine.handle(request),
    refresh: () => engine.refresh(),
    setLocale: (locale) => engine.setLocale(locale),
    stop: () => {
      clearTimeout(startTimer);
      engine.stop();
    },
  };
}

function workerEntry(): { url: URL; execArgv?: string[] } {
  const self = fileURLToPath(import.meta.url);
  if (self.endsWith('.ts')) {
    // --dev: run the TypeScript source through the repository loader.
    return {
      url: new URL('./worker.ts', import.meta.url),
      execArgv: ['--import', new URL('../../../../../scripts/ts-loader.mjs', import.meta.url).href],
    };
  }
  return { url: new URL('./worker.js', import.meta.url) };
}

/** The part of `node:worker_threads` Worker the host uses (injectable for tests). */
export interface WorkerLike {
  on(event: 'message', listener: (message: FromWorker) => void): unknown;
  on(event: 'error', listener: (err: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  postMessage(message: ToWorker): void;
  terminate(): Promise<number> | unknown;
  unref(): void;
}

export function createWorkerHost(
  initialOptions: HostOptions = {},
  inlineFallback: (options: HostOptions) => DeckHost = createInlineHost,
  spawnWorker: () => WorkerLike = () => {
    const entry = workerEntry();
    return new Worker(entry.url, entry.execArgv ? { execArgv: entry.execArgv } : {}) as WorkerLike;
  }
): DeckHost {
  // Mutable copy: a locale switch must also reach a later in-process fallback.
  const options: HostOptions = { ...initialOptions };
  const listeners = new Listeners();
  const worker = spawnWorker();
  worker.unref();
  let nextId = 1;
  let stopped = false;
  /** Set once the worker died: everything is served in-process from then on. */
  let fallback: DeckHost | undefined;
  let workerFailure = '';
  const pending = new Map<
    number,
    { resolve: (value: HostResponseValue) => void; reject: (err: Error) => void }
  >();
  const send = (message: ToWorker) => {
    if (!fallback && !stopped) worker.postMessage(message);
  };
  const withWorkerHealth = (snapshot: DeckSnapshot): DeckSnapshot => ({
    ...snapshot,
    health: [
      ...snapshot.health.filter((h) => h.source !== 'worker'),
      { source: 'worker', ok: false, detail: workerFailure },
    ],
  });

  const failOver = (reason: string) => {
    if (fallback || stopped) return;
    workerFailure = reason;
    const error = new Error(reason);
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
    fallback = inlineFallback(options);
    // The deck keeps working in-process; the header shows the degraded source.
    fallback.subscribe((snapshot) => listeners.emit(withWorkerHealth(snapshot)));
    void worker.terminate();
  };

  worker.on('message', (message: FromWorker) => {
    if (fallback) return;
    if (message.type === 'snapshot') {
      listeners.emit(message.snapshot);
    } else if (message.type === 'response') {
      const entryPending = pending.get(message.id);
      if (!entryPending) return;
      pending.delete(message.id);
      if (message.ok) entryPending.resolve(message.value);
      else entryPending.reject(new Error(message.error));
    } else if (message.type === 'fatal') {
      failOver(message.error);
    }
  });
  worker.on('error', (err: unknown) => failOver(err instanceof Error ? err.message : String(err)));
  worker.on('exit', (code: number) => {
    if (!stopped) failOver(`data worker exited (code ${code})`);
  });

  send({
    type: 'config',
    locale: options.locale,
    intervalMs: options.intervalMs ?? 2000,
    includeAgents: options.includeAgents ?? true,
    operatorBaseRole: options.operatorBaseRole,
  });

  return {
    get mode() {
      return fallback ? 'inline' : 'worker';
    },
    subscribe: (listener) => listeners.add(listener),
    request: (request) => {
      if (fallback) return fallback.request(request);
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        send({ type: 'request', id, request });
      });
    },
    refresh: () => (fallback ? fallback.refresh() : send({ type: 'refresh' })),
    setLocale: (locale) => {
      options.locale = locale;
      if (fallback) fallback.setLocale(locale);
      else send({ type: 'locale', locale });
    },
    stop: () => {
      send({ type: 'stop' });
      stopped = true;
      fallback?.stop();
      void worker.terminate();
    },
  };
}
