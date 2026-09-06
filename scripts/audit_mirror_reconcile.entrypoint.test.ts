import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { main } from './audit_mirror_reconcile.js';

describe('audit mirror reconcile entrypoint', () => {
  it('keeps reconcile results and approval failures behind the shared harness', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/audit_mirror_reconcile.ts'));

    expect(source).toContain('context.print(outcome.result)');
    expect(source).toContain('new ScriptExitError(');
    expect(source).toContain('readJsonLines<AuditEntry>(safePath');
    expect(source).not.toContain('JSON.parse(line)');
    expect(source).not.toContain('console.log(');
    expect(source).toContain('nowIso, readJsonLines');
  });

  it('handles help without entering the reconciliation write path', () => {
    expect(main(['--help'])).toEqual({
      result: expect.objectContaining({ status: 'help' }),
      failed: false,
    });
  });
});
