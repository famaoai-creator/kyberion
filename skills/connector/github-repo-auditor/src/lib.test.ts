import { describe, it, expect } from 'vitest';
import { classifyRepos } from './lib';

describe('github-repo-auditor lib', () => {
  it('should classify repos by name', () => {
    const repos = [
      { name: 'cp-portal', description: 'd', pushedAt: '2025-01-01', isArchived: false },
      { name: 'common-utils', description: 'd', pushedAt: '2025-01-01', isArchived: false },
    ];
    const mapping = classifyRepos(repos);
    expect(mapping['Customer Portal (CP)']).toHaveLength(1);
    expect(mapping['Common / Library']).toHaveLength(1);
  });
});
