import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';

describe('agent runtime supervisor daemon readers', () => {
  it('uses the foundation text reader for daemon lock inspection', () => {
    const source = readTextFile(
      pathResolver.rootResolve('scripts/agent_runtime_supervisor_daemon.ts')
    );

    expect(source).toContain('readTextFile(lockPath)');
    expect(source).not.toContain('safeReadFile');
  });
});
