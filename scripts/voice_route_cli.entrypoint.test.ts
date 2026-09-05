import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('voice route CLI entrypoint', () => {
  it('uses the shared command and output boundary', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/voice_route_cli.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain("name: 'voice:route'");
    expect(source).toContain('stripSharedScriptFlags(argv)');
    expect(source).toContain('run: async ({ argv, dryRun, check, print })');
    expect(source).toContain('print(result);');
    expect(source).toContain("reason_code: 'DRY_RUN'");
    expect(source).toContain('} else if (');
    expect(source).not.toContain('flags: []');
    expect(source).not.toContain('console.log(');
  });
});
