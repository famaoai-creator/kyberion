import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { main } from './audit_mirror_reconcile.js';

describe('audit mirror reconcile entrypoint', () => {
  it('keeps reconcile results and approval failures behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/audit_mirror_reconcile.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('context.print(outcome.result)');
    expect(source).toContain('new ScriptExitError(');
    expect(source).toContain('parseSafeJsonInput(line,');
    expect(source).not.toContain('JSON.parse(line)');
    expect(source).not.toContain('console.log(');
  });

  it('handles help without entering the reconciliation write path', () => {
    expect(main(['--help'])).toEqual({
      result: expect.objectContaining({ status: 'help' }),
      failed: false,
    });
  });
});
