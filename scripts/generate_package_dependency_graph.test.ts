import { describe, expect, it } from 'vitest';
import {
  collectWorkspacePackages,
  parseWorkspaceGlobs,
  renderDependencyGraph,
} from './generate_package_dependency_graph.js';

describe('package dependency graph generator', () => {
  it('reads the packages list from pnpm-workspace.yaml', () => {
    const yaml =
      'packages:\n  - \'libs/core\'\n  - "libs/shared-*"\n# comment\nminimumReleaseAge: 1\n';
    expect(parseWorkspaceGlobs(yaml)).toEqual(['libs/core', 'libs/shared-*']);
  });

  it('renders groups and declared workspace edges deterministically', () => {
    const graph = renderDependencyGraph([
      { name: '@agent/core', dir: 'libs/core', group: 'core', workspaceDeps: ['@agent/kernel'] },
      { name: '@agent/kernel', dir: 'libs/kernel', group: 'kernel', workspaceDeps: [] },
    ]);
    expect(graph).toContain('subgraph kernel ["Kernel"]');
    expect(graph).toContain('agent_core --> agent_kernel');
    expect(graph.indexOf('subgraph kernel')).toBeLessThan(graph.indexOf('subgraph core'));
  });

  it('never draws a core dependency on a shared or actuator package', () => {
    const core = collectWorkspacePackages().find((pkg) => pkg.name === '@agent/core');
    expect(core?.workspaceDeps).toEqual(['@agent/kernel']);
  });
});
