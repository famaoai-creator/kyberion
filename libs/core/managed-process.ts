import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { runtimeSupervisor, type RuntimeResourceKind, type RuntimeShutdownPolicy } from './runtime-supervisor.js';

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

export function spawnManagedProcess(spec: ManagedProcessSpec): ManagedProcessHandle {
  const child = spawn(spec.command, spec.args || [], spec.spawnOptions);

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
  });

  return { resourceId: spec.resourceId, child };
}

export function touchManagedProcess(resourceId: string): void {
  runtimeSupervisor.touch(resourceId);
}

export function stopManagedProcess(resourceId: string, child: ChildProcess | null): void {
  if (child && !child.killed) {
    child.kill();
  }
  runtimeSupervisor.unregister(resourceId);
}
