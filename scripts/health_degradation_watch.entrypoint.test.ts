import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('health degradation watch entrypoint', () => {
  it('keeps the watch report behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/health_degradation_watch.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('context.print(result)');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('logger.info(');
  });
});
