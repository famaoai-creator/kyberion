import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';

describe('reasoning config entrypoint', () => {
  it('keeps route output and mutation policy behind the shared script harness', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/reasoning_config.ts'));

    expect(source).toContain("flags: ['json', 'dry-run', 'check', 'quiet']");
    expect(source).toContain('run: async ({ argv, print, json, dryRun, check })');
    expect(source).toContain('main(argv, print, { json, dryRun, check })');
    expect(source).toContain('new ScriptExitError');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('console.error(');
    expect(source).toContain("nowIso, readTextFile } from '@agent/core/foundation'");
  });
});
