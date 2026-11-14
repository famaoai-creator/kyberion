/** Platform seam for spawning and terminating the continuous owner controller. */
import { posixContinuousOwnerPlatform } from './continuous_owner_platform_posix.js';
import { windowsContinuousOwnerPlatform } from './continuous_owner_platform_windows.js';

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
