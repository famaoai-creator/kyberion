import { describe, expect, it } from 'vitest';
import { checkCiGateParity, collectPnpmScriptReferences } from './check_ci_gate_parity.js';

describe('CI gate parity', () => {
  it('keeps manifest scopes connected to their workflow entrypoints', () => {
    expect(checkCiGateParity()).toEqual([]);
  });

  it('extracts package-script references from manifest command arguments', () => {
    expect(collectPnpmScriptReferences('pnpm run audit:verify --days 7 --warn-only')).toEqual([
      'audit:verify',
    ]);
    expect(collectPnpmScriptReferences('pnpm exec vitest run tests/example.test.ts')).toEqual([]);
  });
});
