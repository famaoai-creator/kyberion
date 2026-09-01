import { describe, expect, it } from 'vitest';
import { readGovernanceJson } from './check_contract_schemas_shared.js';

describe('contract schema shared loader resource boundary', () => {
  it('rejects governance JSON outside the repository root', () => {
    expect(() => readGovernanceJson('/tmp/governance-catalog.json')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
  });
});
