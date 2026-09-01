import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('peer runtime recovery entrypoint', () => {
  it('keeps recovery output behind the shared harness boundary', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/peer_runtime_recovery.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('print(result)');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('logger.success(');
  });
});
