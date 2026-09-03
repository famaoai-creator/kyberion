import { describe, expect, it } from 'vitest';
import { loadKnowledgeTaxonomy, loadKnowledgeTaxonomyAtPath } from './knowledge-taxonomy.js';
import { pathResolver } from './path-resolver.js';

describe('knowledge taxonomy loader', () => {
  it('loads the governed taxonomy through its complete contract', () => {
    const taxonomy = loadKnowledgeTaxonomy();
    expect(taxonomy.version).toBeTruthy();
    expect(taxonomy.kinds.governance).toMatchObject({
      default_authority: 'policy',
      default_scope: 'global',
    });
    expect(taxonomy.directory_defaults.length).toBeGreaterThan(0);
  });

  it('rejects paths outside the repository', () => {
    expect(() => loadKnowledgeTaxonomyAtPath('../outside.json')).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects a directory at the taxonomy resource boundary', () => {
    expect(() => loadKnowledgeTaxonomyAtPath(pathResolver.knowledge('product/governance'))).toThrow(
      '[KNOWLEDGE_TAXONOMY] taxonomy must be a regular file'
    );
  });
});
