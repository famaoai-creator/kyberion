import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('promote procedure resource boundaries', () => {
  it('uses the governed parser for intent phrase input', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/promote_procedure.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain("parseSafeJsonInput(intentPhrasesRaw || '[]', '--intent-phrases')");
    expect(source).not.toContain('JSON.parse(intentPhrasesRaw)');
  });
});
