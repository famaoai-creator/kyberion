import { logger } from './core.js';

export type RuntimeResourceKind = 'pty' | 'agent' | 'service' | 'gateway' | 'ui';
export type RuntimeShutdownPolicy = 'manual' | 'idle' | 'detached';
export type RuntimeResourceState = 'running' | 'stopped' | 'exited';

export interface RuntimeRegistration {
  resourceId: string;
  kind: RuntimeResourceKind;
  ownerId: string;
  ownerType: string;
  pid?: number;
  idleTimeoutMs?: number;
  shutdownPolicy?: RuntimeShutdownPolicy;
  metadata?: Record<string, unknown>;
  cleanup?: () => void | Promise<void>;
}

export interface RuntimeResourceRecord extends RuntimeRegistration {
  createdAt: number;
  lastActiveAt: number;
  shutdownPolicy: RuntimeShutdownPolicy;
  state: RuntimeResourceState;
}

export interface RuntimeResourceSnapshot extends RuntimeResourceRecord {
  idleForMs: number;
}

class RuntimeSupervisorImpl {
  private resources = new Map<string, RuntimeResourceRecord>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private exitHooksInstalled = false;
  private cleanupStarted = false;

  private installExitHooks(): void {
    if (this.exitHooksInstalled) return;
    this.exitHooksInstalled = true;

    const cleanupAndExit = (exitCode: number) => {
      if (this.cleanupStarted) return;
      this.cleanupStarted = true;

      const forceExitTimer = setTimeout(() => process.exit(exitCode), 1500);
      forceExitTimer.unref?.();

      this.cleanupAll(`signal:${exitCode}`)
        .catch(() => {})
        .finally(() => {
          clearTimeout(forceExitTimer);
          process.exit(exitCode);
        });
    };

    process.once('SIGINT', () => cleanupAndExit(130));
    process.once('SIGTERM', () => cleanupAndExit(143));
  }

  register(input: RuntimeRegistration): RuntimeResourceRecord {
    this.installExitHooks();
    const now = Date.now();
    const record: RuntimeResourceRecord = {
      ...input,
      createdAt: now,
      lastActiveAt: now,
      shutdownPolicy: input.shutdownPolicy || 'manual',
      state: 'running',
    };

    this.resources.set(input.resourceId, record);
    return record;
  }

  get(resourceId: string): RuntimeResourceRecord | undefined {
    return this.resources.get(resourceId);
  }

  list(): RuntimeResourceRecord[] {
    return Array.from(this.resources.values()).sort((left, right) => left.createdAt - right.createdAt);
  }

  snapshot(now = Date.now()): RuntimeResourceSnapshot[] {
    return this.list().map((record) => ({
      ...record,
      idleForMs: Math.max(0, now - record.lastActiveAt),
    }));
  }

  touch(resourceId: string): void {
    const record = this.resources.get(resourceId);
    if (record) {
      record.lastActiveAt = Date.now();
    }
  }

  update(
    resourceId: string,
    patch: Partial<Omit<RuntimeResourceRecord, 'resourceId' | 'createdAt'>>,
  ): RuntimeResourceRecord | undefined {
    const record = this.resources.get(resourceId);
    if (!record) return undefined;
    Object.assign(record, patch);
    return record;
  }

  unregister(resourceId: string): boolean {
    return this.resources.delete(resourceId);
  }

  async cleanup(resourceId: string, reason = 'manual'): Promise<boolean> {
    const record = this.resources.get(resourceId);
    if (!record) return false;

    try {
      await record.cleanup?.();
    } catch (error: any) {
      logger.warn(`[RUNTIME_SUPERVISOR] Cleanup failed for ${resourceId} (${reason}): ${error?.message || error}`);
    } finally {
      this.resources.delete(resourceId);
    }

    return true;
  }

  async cleanupAll(reason = 'manual'): Promise<string[]> {
    const resourceIds = this.list().map((record) => record.resourceId);
    const cleaned: string[] = [];

    for (const resourceId of resourceIds) {
      const didCleanup = await this.cleanup(resourceId, reason);
      if (didCleanup) cleaned.push(resourceId);
    }

    return cleaned;
  }

  async reapIdle(now = Date.now()): Promise<string[]> {
    const expired = this.list().filter((record) => {
      if (record.shutdownPolicy !== 'idle' || !record.idleTimeoutMs) return false;
      if (record.state !== 'running') return false;
      return now - record.lastActiveAt >= record.idleTimeoutMs;
    });

    const reaped: string[] = [];
    for (const record of expired) {
      await this.cleanup(record.resourceId, 'idle_timeout');
      reaped.push(record.resourceId);
    }

    return reaped;
  }

  startSweep(intervalMs = 30000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.reapIdle().catch((error: any) => {
        logger.warn(`[RUNTIME_SUPERVISOR] Idle sweep failed: ${error?.message || error}`);
      });
    }, intervalMs);
    this.sweepTimer.unref?.();
  }

  stopSweep(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  resetForTests(): void {
    this.stopSweep();
    this.resources.clear();
    this.cleanupStarted = false;
    this.exitHooksInstalled = false;
  }
}

const GLOBAL_KEY = Symbol.for('@kyberion/runtime-supervisor');
if (!(globalThis as any)[GLOBAL_KEY]) {
  (globalThis as any)[GLOBAL_KEY] = new RuntimeSupervisorImpl();
}

export const runtimeSupervisor: RuntimeSupervisorImpl = (globalThis as any)[GLOBAL_KEY];
