import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  checkCiGateParity,
  checkValidateComposition,
  checkWorkflowSetupOrder,
  collectCheckScopeReferences,
  collectPnpmScriptReferences,
  readCiGateParityTextFile,
} from './check_ci_gate_parity.js';

describe('ci gate parity', () => {
  it('rejects a directory replacement before workflow parsing', () => {
    expect(() => readCiGateParityTextFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });

  it('uses the governed package manifest loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_ci_gate_parity.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('readSafeJsonFile');
    expect(source).toContain('readTextFile');
    expect(source).not.toContain('safeReadFile(pathResolver.rootResolve(relativePath)');
    expect(source).not.toContain('readJson<{ scripts?: Record<string, string> }>(');
  });

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

  it('keeps validate aligned with the build, typecheck, and full gate sequence', () => {
    expect(
      checkValidateComposition(
        'pnpm run build && pnpm run typecheck && pnpm run check -- --scope full'
      )
    ).toEqual([]);
    expect(checkValidateComposition('pnpm run build && pnpm run check -- --scope full')).toEqual([
      'package.json validate script is missing pnpm run typecheck',
    ]);
    expect(checkValidateComposition('pnpm run typecheck')).toEqual([
      'package.json validate script is missing pnpm run build',
      'package.json validate script is missing pnpm run check -- --scope full',
    ]);
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
