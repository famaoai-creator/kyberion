import { describe, expect, it } from 'vitest';
import {
  loadMediaDrawioEdgePolicyCatalog,
  resolveDrawioEdgeLabelStyleParts,
  resolveDrawioEdgeRoutingStyleParts,
} from './media-drawio-edge-policy.js';

describe('media-drawio-edge-policy', () => {
  it('resolves edge label and routing styles from knowledge', () => {
    const catalog = loadMediaDrawioEdgePolicyCatalog();

    expect(catalog.edge_labels.length).toBeGreaterThan(0);
    expect(resolveDrawioEdgeLabelStyleParts('source')).toContain('endArrow=open');
    expect(resolveDrawioEdgeRoutingStyleParts({ sourceTier: 'security', targetTier: 'web' })).toEqual([
      'exitX=0',
      'exitY=0.5',
      'entryX=1',
      'entryY=0.5',
    ]);
  });
});
