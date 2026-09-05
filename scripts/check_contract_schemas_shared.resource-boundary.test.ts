import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { readGovernanceJson } from './check_contract_schemas_shared.js';

describe('contract schema shared loader resource boundary', () => {
  it('uses the governed JSON value loader after path validation', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_contract_schemas_shared.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('readSafeJsonValueFile');
    expect(source).not.toContain('readJson<Record<string, unknown>>');
  });

  it('rejects governance JSON outside the repository root', () => {
    expect(() => readGovernanceJson('/tmp/governance-catalog.json')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
  });
});
