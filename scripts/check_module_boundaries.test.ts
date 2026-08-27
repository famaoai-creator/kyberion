import { describe, expect, it } from 'vitest';
import { checkModuleBoundaries } from './check_module_boundaries.js';

describe('module boundary ratchet', () => {
  it('does not allow cycles or forbidden direction edges to grow', () => {
    const report = checkModuleBoundaries();
    expect(report.violations).toEqual([]);
  });

  it('does not treat import examples inside comments as runtime edges', () => {
    const report = checkModuleBoundaries();
    expect(report.cycles.flat()).not.toContain('scripts/dependency_resolver.ts');
  });

  it('does not treat type-only imports as runtime cycles', () => {
    const report = checkModuleBoundaries();
    expect(report.cycles.some((cycle) => cycle.includes('libs/core/deployment-adapter.ts'))).toBe(
      false
    );
  });
});
