import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('control_plane_cli entrypoint', () => {
  it('routes CLI output through the harness printer and centralizes failure status', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/control_plane_cli.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source.match(/process\.stdout\.write\(/g)).toHaveLength(1);
    expect(source).not.toContain('process.stderr.write(');
    expect(source).not.toContain('process.exitCode =');
    expect(source).not.toContain('console.warn(');
    expect(source).toContain('const defaultPrint: Print');
    expect(source).toContain('withOutputPrinter(print');
    expect(source).toContain("throw new ScriptExitError(1, '', true)");
  });
});
