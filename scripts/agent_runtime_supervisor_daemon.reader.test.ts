import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { readDaemonLockTextFile } from './agent_runtime_supervisor_daemon.js';

describe('agent runtime supervisor daemon readers', () => {
  it('uses the foundation text reader for daemon lock inspection', () => {
    const source = readTextFile(
      pathResolver.rootResolve('scripts/agent_runtime_supervisor_daemon.ts')
    );

    expect(source).toContain('readDaemonLockTextFile(lockPath)');
    expect(source).not.toContain('safeReadFile');
  });

  it('rejects a directory replacement before PID parsing', () => {
    expect(() => readDaemonLockTextFile(pathResolver.rootDir())).toThrow(
      `${pathResolver.rootDir()} must be a regular file`
    );
  });
});
