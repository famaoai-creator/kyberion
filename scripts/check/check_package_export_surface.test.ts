import { describe, expect, it } from 'vitest';
import {
  collectExportCounts,
  compareExportSurface,
  countPackageExports,
} from './check_package_export_surface.js';

describe('package export surface ratchet', () => {
  it('counts published subpaths only', () => {
    expect(countPackageExports({ exports: { '.': {}, './a': {}, './b': {} } })).toBe(3);
    expect(countPackageExports({ main: './dist/index.js' })).toBe(0);
    expect(countPackageExports({ exports: './dist/index.js' })).toBe(0);
  });

  it('fails when a package grows past its baseline and reports shrinkage', () => {
    const report = compareExportSurface(
      { 'libs/core': 11, 'libs/kernel': 3, 'libs/new': 2 },
      { version: 1, packages: { 'libs/core': 10, 'libs/kernel': 4, 'libs/gone': 1 } }
    );
    expect(report.violations).toEqual([
      expect.stringContaining('libs/core: publishes 11 subpaths, baseline allows 10 (+1)'),
      expect.stringContaining('libs/new: publishes 2 subpaths but has no baseline entry'),
    ]);
    expect(report.shrunk).toEqual([
      'libs/gone: no longer publishes an exports map',
      'libs/kernel: 3 < baseline 4',
    ]);
  });

  it('passes on the repository baseline', () => {
    const counts = collectExportCounts();
    expect(counts['libs/core']).toBeGreaterThan(0);
  });
});
