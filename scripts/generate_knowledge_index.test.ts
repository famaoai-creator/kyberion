import { describe, expect, it } from 'vitest';
import {
  generateIndex,
  runGenerateKnowledgeIndex,
  validateKnowledgeFrontmatter,
} from './generate_knowledge_index.js';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('generate_knowledge_index', () => {
  it('keeps the compatibility check API green for the current snapshot', () => {
    expect(generateIndex(true)).toBe(true);
  });

  it('uses the shared generator contract for a clean check', async () => {
    const result = await runGenerateKnowledgeIndex(['--check', '--quiet']);
    expect(result?.changed).toEqual([]);
  });

  it('keeps the generator behind the shared JSON parser', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/generate_knowledge_index.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain("parseSafeJsonInput(content, 'knowledge integrity manifest')");
    expect(source).toContain('parseSafeJsonInput, readTextFile } from');
    expect(source).not.toContain('safeReadFile(');
    expect(source).not.toContain('JSON.parse(content)');
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
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
});
