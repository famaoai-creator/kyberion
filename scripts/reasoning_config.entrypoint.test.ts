import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('reasoning config entrypoint', () => {
  it('keeps route output and mutation policy behind the shared script harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/reasoning_config.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain("flags: ['json', 'dry-run', 'check', 'quiet']");
    expect(source).toContain('run: async ({ argv, print, json, dryRun, check })');
    expect(source).toContain('main(argv, print, { json, dryRun, check })');
    expect(source).toContain('new ScriptExitError');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('console.error(');
  });
});
