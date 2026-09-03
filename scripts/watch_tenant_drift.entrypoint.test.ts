import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { main } from './watch_tenant_drift.js';

describe('tenant drift watchdog entrypoint', () => {
  it('keeps drift and alert output behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/watch_tenant_drift.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('print(json ? result.report');
    expect(source).toContain('new ScriptExitError(');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('logger.info(');
    expect(source).not.toContain('logger.warn(');
  });

  it('uses the canonical schema-validated mission state loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/watch_tenant_drift.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('loadStateAtPath(statePath)');
    expect(source).not.toContain('readJson(');
  });

  it('handles help without scanning confidential mission state', () => {
    expect(main(['--help'])).toEqual({
      status: 0,
      alert: null,
      help: expect.stringContaining('watch:tenant-drift'),
    });
  });
});
