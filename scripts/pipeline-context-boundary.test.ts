import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('pipeline context resource boundary', () => {
  it('uses the governed object parser for --context', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/pipeline-execution-part-results.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain(
      "parseSafeJsonObjectInput(argv.context as string, 'pipeline --context')"
    );
    expect(source).not.toContain('JSON.parse(argv.context as string)');
  });
});
