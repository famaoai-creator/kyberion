import { describe, expect, it } from 'vitest';

import { loadProjectOperatingSystemArtifactMap } from './project-management.js';

describe('project operating system artifact map', () => {
  it('loads the governed lifecycle map used by project scaffolding', () => {
    const artifactMap = loadProjectOperatingSystemArtifactMap();

    expect(artifactMap.concept).toBe('project-operating-system');
    expect(artifactMap.layers.length).toBeGreaterThan(0);
    expect(artifactMap.lifecycle.map((phase) => phase.phase)).toEqual([
      'initiate',
      'define',
      'design',
      'build',
      'validate',
      'transfer_run',
    ]);
    expect(artifactMap.dependencies.every(([from, to]) => Boolean(from && to))).toBe(true);
  });
});
