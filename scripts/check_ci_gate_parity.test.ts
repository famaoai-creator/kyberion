import { describe, expect, it } from 'vitest';
import {
  checkCiGateParity,
  checkWorkflowSetupOrder,
  collectCheckScopeReferences,
  collectPnpmScriptReferences,
} from './check_ci_gate_parity.js';

describe('ci gate parity', () => {
  it('keeps the checked-in workflows and baseline declarations aligned', () => {
    expect(checkCiGateParity()).toEqual([]);
  });

  it('extracts package-script references from manifest command arguments', () => {
    expect(collectPnpmScriptReferences('pnpm run audit:verify --days 7 --warn-only')).toEqual([
      'audit:verify',
    ]);
    expect(collectPnpmScriptReferences('pnpm exec vitest run tests/example.test.ts')).toEqual([]);
  });

  it('collects multiple package-manager script references without shell noise', () => {
    expect(
      collectPnpmScriptReferences(
        'pnpm run check:one && pnpm exec vitest run && pnpm run check:two -- --check'
      )
    ).toEqual(['check:one', 'check:two']);
  });

  it('recognizes only canonical check scope invocations', () => {
    expect(
      collectCheckScopeReferences(
        'pnpm run check -- --scope full && pnpm run check -- --scope full --only catalogs'
      )
    ).toEqual(['full']);
  });

  it('requires repository checkout before the shared setup action', () => {
    expect(
      checkWorkflowSetupOrder(
        '.github/workflows/example.yml',
        'uses: actions/checkout@v4\nuses: ./.github/actions/setup-kyberion'
      )
    ).toEqual([]);
    expect(
      checkWorkflowSetupOrder(
        '.github/workflows/example.yml',
        'uses: ./.github/actions/setup-kyberion\nuses: actions/checkout@v4'
      )
    ).toEqual(['.github/workflows/example.yml must checkout the repository before setup']);
    expect(
      checkWorkflowSetupOrder('.github/workflows/example.yml', 'uses: actions/checkout@v4')
    ).toEqual(['.github/workflows/example.yml must use uses: ./.github/actions/setup-kyberion']);
  });
});
