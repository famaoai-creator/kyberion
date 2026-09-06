import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('chronos_daemon entrypoint', () => {
  it('delegates fatal exit handling to the shared script harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/chronos_daemon.ts'), { encoding: 'utf8' })
    );
    expect(source).not.toContain('process.exitCode =');
    expect(source).toContain('throw new ScriptExitError(1, message)');
    expect(source).toContain("recordDaemonHeartbeat('chronos-daemon'");
    expect(source).toContain("dedupe_key: 'chronos-daemon:fatal'");
  });
});
