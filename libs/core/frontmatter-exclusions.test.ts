import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import {
  loadFrontmatterExclusions,
  loadFrontmatterExclusionsAtPath,
} from './frontmatter-exclusions.js';

describe('frontmatter exclusion manifest loader', () => {
  it('loads the governed manifest through its complete contract', () => {
    const manifest = loadFrontmatterExclusions();
    expect(manifest.manifest_version).toBe(1);
    expect(manifest.excluded_paths.length).toBeGreaterThan(0);
  });

  it('rejects paths outside the repository', () => {
    expect(() => loadFrontmatterExclusionsAtPath('../outside.json')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
  });

  it('rejects a directory at the manifest resource boundary', () => {
    expect(() =>
      loadFrontmatterExclusionsAtPath(pathResolver.knowledge('product/governance'))
    ).toThrow('[FRONTMATTER_EXCLUSIONS] manifest must be a regular file');
  });
});
