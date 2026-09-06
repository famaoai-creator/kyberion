/* eslint-disable no-restricted-imports -- foundation process wrapper; callers should use this instead of direct child_process */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import {
  runtimeSupervisor,
  type RuntimeResourceKind,
  type RuntimeShutdownPolicy,
} from './runtime-supervisor.js';
import { createLogger } from './logger.js';
import { clamp } from './foundation/text.js';

const logger = createLogger('managed-process');

export interface ManagedProcessSpec {
  resourceId: string;
  kind: RuntimeResourceKind;
  ownerId: string;
  ownerType: string;
  command: string;
  args?: string[];
  spawnOptions?: SpawnOptions;
  shutdownPolicy?: RuntimeShutdownPolicy;
  idleTimeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ManagedProcessHandle {
  resourceId: string;
  child: ChildProcess;
}

export type ManagedProcessWatchEventKind = 'output' | 'exited' | 'expired' | 'lost' | 'quiet';

export interface ManagedProcessWatchEvent {
  kind: ManagedProcessWatchEventKind;
  resourceId: string;
  pid?: number;
  at: string;
  tail: string;
  code?: number | null;
  signal?: string | null;
}

export interface ManagedProcessWatchOptions {
  outputRegex?: RegExp;
  quietMs?: number;
  maxDurationMs?: number;
  minTriggerIntervalMs?: number;
  maxTailBytes?: number;
  onEvent: (event: ManagedProcessWatchEvent) => void | Promise<void>;
}

export interface ManagedProcessWatchHandle {
  resourceId: string;
  stop(): void;
}

const managedHandles = new Map<string, ManagedProcessHandle>();

export function spawnManagedProcess(spec: ManagedProcessSpec): ManagedProcessHandle {
  const child = spawn(spec.command, spec.args || [], spec.spawnOptions ?? {});
  const handle = { resourceId: spec.resourceId, child };
  managedHandles.set(spec.resourceId, handle);

  runtimeSupervisor.register({
    resourceId: spec.resourceId,
    kind: spec.kind,
    ownerId: spec.ownerId,
    ownerType: spec.ownerType,
    pid: child.pid,
    idleTimeoutMs: spec.idleTimeoutMs,
    shutdownPolicy: spec.shutdownPolicy || 'manual',
    metadata: {
      command: spec.command,
      args: spec.args || [],
      ...(spec.metadata || {}),
    },
    cleanup: () => {
      if (!child.killed) {
        child.kill();
      }
    },
  });

  child.on('spawn', () => {
    runtimeSupervisor.update(spec.resourceId, {
      pid: child.pid,
      state: 'running',
      lastActiveAt: Date.now(),
    });
  });

  child.on('exit', () => {
    runtimeSupervisor.update(spec.resourceId, {
      state: 'exited',
      lastActiveAt: Date.now(),
    });
    managedHandles.delete(spec.resourceId);
  });

  return handle;
}

/**
 * Arm a bounded declarative watch over a managed process. It never spawns a
 * second reader and emits at most one event per minimum trigger interval.
 */
export function armWatch(
  resourceId: string,
  options: ManagedProcessWatchOptions
): ManagedProcessWatchHandle {
  const handle = managedHandles.get(resourceId);
  let stopped = false;
  let quietTimer: ReturnType<typeof setInterval> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastEventAt = 0;
  let lastOutputAt = Date.now();
  let quietEmitted = false;
  let tail = '';
  const maxTailBytes = clamp(options.maxTailBytes || 64 * 1024, 1024, 256 * 1024);
  const minTriggerIntervalMs = Math.max(0, options.minTriggerIntervalMs ?? 1000);

  const emit = (
    kind: ManagedProcessWatchEventKind,
    extra: Partial<ManagedProcessWatchEvent> = {}
  ) => {
    if (stopped) return;
    const now = Date.now();
    if (kind !== 'exited' && kind !== 'lost' && now - lastEventAt < minTriggerIntervalMs) return;
    lastEventAt = now;
    Promise.resolve(
      options.onEvent({
        kind,
        resourceId,
        pid: handle?.child.pid,
        at: new Date(now).toISOString(),
        tail,
        ...extra,
      })
    ).catch((error) => {
      logger.warn(
        `[WATCH_CALLBACK_FAILED] resource=${resourceId}: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  };

  const onData = (chunk: Buffer | string) => {
    const text = String(chunk);
    const combined = Buffer.concat([Buffer.from(tail), Buffer.from(text)]);
    tail = combined.subarray(-maxTailBytes).toString('utf8');
    lastOutputAt = Date.now();
    quietEmitted = false;
    touchManagedProcess(resourceId);
    if (!options.outputRegex) return;
    options.outputRegex.lastIndex = 0;
    if (options.outputRegex.test(text)) emit('output');
  };
  const onExit = (code: number | null, signal: string | null) => {
    emit('exited', { code, signal });
    stop();
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (quietTimer) clearInterval(quietTimer);
    if (expiryTimer) clearTimeout(expiryTimer);
    handle?.child.stdout?.removeListener('data', onData);
    handle?.child.stderr?.removeListener('data', onData);
    handle?.child.removeListener('exit', onExit);
  };

  if (!handle) {
    emit('lost');
    stop();
    return { resourceId, stop };
  }

  handle.child.stdout?.on('data', onData);
  handle.child.stderr?.on('data', onData);
  handle.child.once('exit', onExit);

  if (options.quietMs && options.quietMs > 0) {
    quietTimer = setInterval(
      () => {
        if (!quietEmitted && Date.now() - lastOutputAt >= options.quietMs!) {
          quietEmitted = true;
          emit('quiet');
        }
      },
      Math.min(options.quietMs, 1000)
    );
    quietTimer.unref?.();
  }
  if (options.maxDurationMs && options.maxDurationMs > 0) {
    expiryTimer = setTimeout(() => {
      emit('expired');
      stop();
    }, options.maxDurationMs);
    expiryTimer.unref?.();
  }

  return { resourceId, stop };
}

export function touchManagedProcess(resourceId: string): void {
  runtimeSupervisor.touch(resourceId);
}

export function stopManagedProcess(resourceId: string, child: ChildProcess | null): void {
  if (child && !child.killed) {
    child.kill();
  }
  runtimeSupervisor.unregister(resourceId);
  managedHandles.delete(resourceId);
}
