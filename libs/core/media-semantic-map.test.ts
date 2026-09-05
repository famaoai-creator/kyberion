import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  loadMediaSemanticMapCatalog,
  resolveMediaSemanticType,
  resolveProposalEvidenceIndex,
  resolveProposalSectionKeywords,
} from './media-semantic-map.js';

describe('media-semantic-map', () => {
  it('uses the canonical catalog without a duplicated fallback definition', () => {
    const source = safeReadFile(pathResolver.rootResolve('libs/core/media-semantic-map.ts'), {
      encoding: 'utf8',
    }) as string;
    expect(source).not.toContain('FALLBACK_');
    expect(source).not.toContain('fallback:');
  });

  it('resolves semantic types and proposal evidence indexes', () => {
    const catalog = loadMediaSemanticMapCatalog();

    expect(catalog.rules.length).toBeGreaterThan(0);
    expect(resolveMediaSemanticType('cover-statement', 'hero')).toBe('hero');
    expect(resolveMediaSemanticType('sheet-main-table', 'table')).toBe('execution');
    expect(resolveProposalEvidenceIndex('delivery-plan')).toBe(3);
    expect(resolveProposalSectionKeywords('delivery-plan')).toContain('roadmap');
  });
});
