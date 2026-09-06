import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('run_generation_schedule_daemon', () => {
  it('delegates fatal exit handling to the shared script harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/run_generation_schedule_daemon.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('process.exitCode =');
    expect(source).toContain('throw new ScriptExitError(1, message)');
    expect(source).toContain('recordDaemonHeartbeat(DAEMON_ID');
    expect(source).toContain('sendOpsAlert({');
  });
});
