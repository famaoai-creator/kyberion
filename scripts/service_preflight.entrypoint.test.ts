import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('service preflight entrypoint', () => {
  it('keeps report rendering and exit handling behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/service_preflight.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain("context.print(context.json ? { status: 'ok', report } :");
    expect(source).toContain("new ScriptExitError(1, '', true, report)");
    expect(source).toContain("const normalizedArgs = args[0] === '--' ? args.slice(1) : args;");
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('logger.info(');
    expect(source).not.toContain('flags: []');
  });
});
