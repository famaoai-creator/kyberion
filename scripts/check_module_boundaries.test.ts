import { beforeAll, describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { checkModuleBoundaries, readModuleBoundaryTextFile } from './check_module_boundaries.js';

describe('module boundary ratchet', () => {
  // The full-repo import walk takes ~20s locally (longer on shared CI
  // runners); compute it once and share it instead of re-walking per test.
  let report: ReturnType<typeof checkModuleBoundaries>;
  beforeAll(() => {
    report = checkModuleBoundaries();
  }, 180_000);
  it('rejects a directory replacement before import parsing', () => {
    expect(() => readModuleBoundaryTextFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });

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
    expect(report.violations).toEqual([]);
    expect(report.directionViolations).toEqual([]);
    expect(report.directionExceptions).toEqual([
      'libs/core/secure-io.ts -> libs/core/audit-chain.ts',
      'libs/core/secure-io.ts -> libs/core/sandbox-policy.ts',
      'libs/core/secure-io.ts -> libs/core/tier-guard.ts',
    ]);
    expect(report.staleDirectionExceptions).toEqual([]);
  });

  it('does not treat import examples inside comments as runtime edges', () => {
    expect(report.cycles.flat()).not.toContain('scripts/dependency_resolver.ts');
  });

  it('does not treat type-only imports as runtime cycles', () => {
    expect(report.cycles.some((cycle) => cycle.includes('libs/core/deployment-adapter.ts'))).toBe(
      false
    );
  });
});
