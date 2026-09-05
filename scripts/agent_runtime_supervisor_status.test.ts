import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('agent runtime supervisor status entrypoint', () => {
  it('keeps healthy and degraded status output behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/agent_runtime_supervisor_status.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('print(result)');
    expect(source).not.toContain('console.log(');
  });
});
