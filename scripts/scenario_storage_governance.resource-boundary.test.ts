import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core';
import { readScenarioTextFile } from './scenario_storage_governance.js';

describe('storage governance scenario resource boundary', () => {
  it('rejects a directory replacement before scenario log parsing', () => {
    expect(() => readScenarioTextFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });

  it('uses the foundation reader for scenario text logs', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/scenario_storage_governance.ts'));
    expect(source).toContain('nowIso, parseSafeJsonInput, readTextFile');
  });

  it('runs only through the harness entrypoint and injected printer', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/scenario_storage_governance.ts'));

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run: ({ print }) => main(print)');
    expect(source).toContain("isDirectScript(import.meta.url, 'scenario_storage_governance.ts')");
  });
  it('uses the governed parser for process log JSONL entries', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/scenario_storage_governance.ts'));
    expect(source).toContain("parseSafeJsonInput(line, 'scenario process log entry')");
    expect(source).not.toContain('JSON.parse(line)');
  });
});
