import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { checkModuleBoundaries } from './check_module_boundaries.js';

describe('module boundary ratchet', () => {
  it('uses the foundation text reader for module source files', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_module_boundaries.ts'), {
        encoding: 'utf8',
      }) || ''
    );
    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
  });

  it('does not allow cycles or forbidden direction edges to grow', () => {
    const report = checkModuleBoundaries();
    expect(report.violations).toEqual([]);
    expect(report.directionViolations).toEqual([]);
    expect(report.directionExceptions).toEqual([
      'libs/core/secure-io.ts -> libs/core/audit-chain.ts',
      'libs/core/secure-io.ts -> libs/core/sandbox-policy.ts',
      'libs/core/secure-io.ts -> libs/core/tier-guard.ts',
    ]);
    expect(report.staleDirectionExceptions).toEqual([]);
  }, 60_000);

  it('does not treat import examples inside comments as runtime edges', () => {
    const report = checkModuleBoundaries();
    expect(report.cycles.flat()).not.toContain('scripts/dependency_resolver.ts');
  }, 60_000);

  it('does not treat type-only imports as runtime cycles', () => {
    const report = checkModuleBoundaries();
    expect(report.cycles.some((cycle) => cycle.includes('libs/core/deployment-adapter.ts'))).toBe(
      false
    );
  }, 60_000);
});
