import { describe, expect, it } from 'vitest';
import { checkModuleBoundaries } from './check_module_boundaries.js';

describe('module boundary ratchet', () => {
  it('does not allow cycles or forbidden direction edges to grow', () => {
    const report = checkModuleBoundaries();
    expect(report.violations).toEqual([]);
  });
});
