import { describe, expect, it } from 'vitest';
import {
  readKnowledgeTextFile,
  selectKnowledgeIndexOutputs,
  validateKnowledgeFrontmatter,
} from './generate_knowledge_index.js';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

/**
 * Deliberately no "repository index is currently clean" assertion here.
 * Vitest runs script files in parallel and many suites write under `knowledge/`,
 * so a live `generateIndex(true)` / `--check` call measures transient churn.
 * Freshness belongs to the serial catalogs gate
 * (`pnpm run check -- --scope full --only catalogs`).
 */
describe('generate_knowledge_index', () => {
  it('keeps the generator on governed text reads', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/generate_knowledge_index.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain("import { readTextFile } from '@agent/core/foundation';");
    expect(source).not.toContain('safeReadFile(');
    expect(source).not.toContain('JSON.parse(content)');
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
  });

  it('keeps the untracked manifest out of freshness checks and the index out of builds', () => {
    const manifest = pathResolver.knowledge('_integrity-manifest.json');
    const index = pathResolver.knowledge('_index.md');
    const files = [
      { path: manifest, content: '{}\n' },
      { path: index, content: '# Index\n' },
    ];

    expect(selectKnowledgeIndexOutputs(files, {}).map((file) => file.path)).toEqual([
      manifest,
      index,
    ]);
    expect(selectKnowledgeIndexOutputs(files, { check: true }).map((file) => file.path)).toEqual([
      index,
    ]);
    expect(
      selectKnowledgeIndexOutputs(files, { unknownFlags: ['--manifest-only'] }).map(
        (file) => file.path
      )
    ).toEqual([manifest]);
  });

  it('requires frontmatter for non-excluded markdown knowledge', () => {
    const reads = new Map([
      ['product/capability-assets/diagram-renderer/README.md', '# Content-first README\n'],
      ['product/architecture/example.md', '# Explicitly excluded architecture note\n'],
      ['product/unknown/example.md', '# Missing metadata\n'],
    ]);
    const failures = validateKnowledgeFrontmatter(
      [...reads.keys()],
      (filePath) => reads.get(filePath.replace(`${pathResolver.knowledge('')}/`, '')) || ''
    );

    expect(failures).toEqual([
      'product/unknown/example.md: missing YAML frontmatter and no explicit exclusion',
    ]);
  });

  it('rejects a directory replacement before knowledge text parsing', () => {
    expect(() => readKnowledgeTextFile(pathResolver.rootDir(), 'fixture')).toThrow(
      'fixture must be a regular file'
    );
  });
});
