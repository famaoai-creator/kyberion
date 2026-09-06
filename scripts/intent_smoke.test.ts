import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { readIntentSmokeTextFile } from './intent_smoke.js';

describe('intent smoke entrypoint', () => {
  it('keeps subprocess summary output behind the shared harness boundary', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/intent_smoke.ts'), { encoding: 'utf8' })
    );

    expect(source).toContain('context.print(result.summaryText)');
    expect(source).toContain('new ScriptExitError(');
    expect(source).not.toContain('process.exitCode');
    expect(source).not.toContain('console.log(');
  });

  it('rejects a directory before reading the smoke summary', () => {
    expect(() => readIntentSmokeTextFile(pathResolver.rootResolve('active'))).toThrow(
      'must be a regular file'
    );
  });
});
