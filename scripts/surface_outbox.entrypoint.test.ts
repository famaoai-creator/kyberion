import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('surface outbox script boundary', () => {
  it('routes list and replay output through the shared script printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/surface_outbox.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).not.toContain('process.stdout.write');
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('runSurfaceOutbox(context.argv, context.print)');
  });
});
