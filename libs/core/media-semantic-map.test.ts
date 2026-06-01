import { describe, expect, it } from 'vitest';
import {
  loadMediaSemanticMapCatalog,
  resolveMediaSemanticType,
  resolveProposalEvidenceIndex,
  resolveProposalSectionKeywords,
} from './media-semantic-map.js';

describe('media-semantic-map', () => {
  it('resolves semantic types and proposal evidence indexes', () => {
    const catalog = loadMediaSemanticMapCatalog();

    expect(catalog.rules.length).toBeGreaterThan(0);
    expect(resolveMediaSemanticType('cover-statement', 'hero')).toBe('hero');
    expect(resolveMediaSemanticType('sheet-main-table', 'table')).toBe('execution');
    expect(resolveProposalEvidenceIndex('delivery-plan')).toBe(3);
    expect(resolveProposalSectionKeywords('delivery-plan')).toContain('roadmap');
  });
});
