/** Platform seam for spawning and terminating the continuous owner controller. */
import { hostname } from 'node:os';
import { posixContinuousOwnerPlatform } from './continuous_owner_platform_posix.js';
import { windowsContinuousOwnerPlatform } from './continuous_owner_platform_windows.js';

export interface ContinuousProcessContainment {
  host: string;
  pid: number;
  kind: 'posix_group' | 'windows_job';
}

export function continuousProcessContainment(
  pid: number,
  detached: boolean
): ContinuousProcessContainment {
  return { host: hostname(), pid, kind: detached ? 'posix_group' : 'windows_job' };
}

export function isRegisteredContinuousWorker(containment: ContinuousProcessContainment): boolean {
  return (
    containment.host === hostname() &&
    containment.pid === (containment.kind === 'posix_group' ? process.pid : process.ppid)
  );
}

/** Require a negative, same-host process probe; inaccessible containers stay held. */
export function isContinuousProcessStopped(containment: ContinuousProcessContainment): boolean {
  if (containment.host !== hostname()) return false;
  try {
    process.kill(containment.kind === 'posix_group' ? -containment.pid : containment.pid, 0);
    return false;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH');
  }
}

export interface ContinuousOwnerChildProcess {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  stdin?: {
    on(event: 'error', listener: (error: Error) => void): unknown;
    end(data: string): void;
  } | null;
}

export interface ContinuousOwnerPlatformInvocation {
  command: string;
  args: string[];
  detached: boolean;
  stdin: 'ignore' | 'pipe';
  writeInput?: (child: ContinuousOwnerChildProcess, onError: (error: Error) => void) => void;
  terminate: (child: ContinuousOwnerChildProcess, onError: (error: Error) => void) => void;
}

export interface ContinuousOwnerPlatformAdapter {
  createInvocation(command: string, args: string[], cwd: string): ContinuousOwnerPlatformInvocation;
}

export function resolveContinuousOwnerPlatform(
  platform: NodeJS.Platform = process.platform
): ContinuousOwnerPlatformAdapter {
  const adapter = continuousOwnerPlatformAdapters[platform];
  if (!adapter) throw new Error(`Unsupported continuous owner platform: ${platform}`);
  return adapter;
}

const continuousOwnerPlatformAdapters: Partial<
  Record<NodeJS.Platform, ContinuousOwnerPlatformAdapter>
> = {
  darwin: posixContinuousOwnerPlatform,
  linux: posixContinuousOwnerPlatform,
  win32: windowsContinuousOwnerPlatform,
};
