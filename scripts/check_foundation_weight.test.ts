import { describe, expect, it } from 'vitest';
import {
  compareFoundationWeight,
  measureFoundationWeight,
  transitiveCount,
} from './check_foundation_weight.js';

const graph = new Map<string, string[]>([
  ['secure-io.js', ['tier-guard.js', 'path-resolver.js']],
  ['tier-guard.js', ['foundation/env.js', 'organization/tenant-registry.js']],
  ['organization/tenant-registry.js', ['foundation/env.js']],
  ['path-resolver.js', []],
  ['foundation/env.js', []],
  ['foundation/index.js', ['foundation/env.js']],
  ['mission/worker.js', ['secure-io.js']],
]);

describe('foundation weight ratchet', () => {
  it('counts transitive runtime imports without the module itself', () => {
    expect(transitiveCount(graph, 'secure-io.js')).toBe(4);
    expect(transitiveCount(graph, 'path-resolver.js')).toBe(0);
  });

  it('watches the named flat modules and foundation/contracts, not barrels or domains', () => {
    expect(measureFoundationWeight(graph)).toEqual({
      'foundation/env': 0,
      'path-resolver': 0,
      'secure-io': 4,
    });
  });

  it('fails on growth or a missing entry and reports a lighter module', () => {
    const report = compareFoundationWeight(
      { 'secure-io': 5, 'path-resolver': 0, 'foundation/new': 1, 'foundation/env': 0 },
      { version: 1, modules: { 'secure-io': 4, 'path-resolver': 2, 'foundation/env': 0 } }
    );
    expect(report.violations).toEqual([
      expect.stringContaining('foundation/new: pulls 1 core modules but has no baseline entry'),
      expect.stringContaining('secure-io: now pulls 5 core modules at runtime, baseline 4 (+1)'),
    ]);
    expect(report.lighter).toEqual(['path-resolver: 0 < baseline 2']);
  });
});
