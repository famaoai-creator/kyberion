import type {
  ContinuousOwnerChildProcess,
  ContinuousOwnerPlatformAdapter,
} from './continuous_owner_platform.js';

function terminateProcessGroup(
  child: ContinuousOwnerChildProcess,
  onError: (error: Error) => void
): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'))
      onError(error instanceof Error ? error : new Error(String(error)));
  }
}

export const posixContinuousOwnerPlatform: ContinuousOwnerPlatformAdapter = {
  createInvocation(command, args) {
    return {
      command,
      args,
      detached: true,
      stdin: 'ignore',
      terminate: terminateProcessGroup,
    };
  },
};
