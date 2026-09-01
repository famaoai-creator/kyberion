import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('daemon watchdog entrypoint', () => {
  it('keeps JSON and human report output behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/daemon_watchdog.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('context.print(context.json ? report :');
    expect(source).toContain('new ScriptExitError(');
    expect(source).not.toContain('console.log(');
  });
});
