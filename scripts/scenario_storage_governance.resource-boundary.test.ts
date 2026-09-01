import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('storage governance scenario resource boundary', () => {
  it('uses the governed parser for process log JSONL entries', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/scenario_storage_governance.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain("parseSafeJsonInput(line, 'scenario process log entry')");
    expect(source).not.toContain('JSON.parse(line)');
  });
});
