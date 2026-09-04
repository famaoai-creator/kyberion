import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('storage governance scenario resource boundary', () => {
  it('runs only through the harness entrypoint and injected printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/scenario_storage_governance.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run: ({ print }) => main(print)');
    expect(source).toContain("isDirectScript(import.meta.url, 'scenario_storage_governance.ts')");
  });
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
