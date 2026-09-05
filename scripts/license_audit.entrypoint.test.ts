import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';

describe('license audit entrypoint', () => {
  it('keeps audit output and check failures behind the shared script harness', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/license_audit.ts'));

    expect(source).toContain("flags: ['json', 'check', 'quiet']");
    expect(source).toContain('context.print(');
    expect(source).toContain('new ScriptExitError(1');
    expect(source).toContain('readSafeJsonFile');
    expect(source).not.toContain('readJson<Record<string, unknown>>');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('console.error(');
    expect(source).toContain("nowIso, readTextFile } from '@agent/core/foundation'");
  });
});
