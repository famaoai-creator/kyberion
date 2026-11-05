import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import {
  loadMediaDrawioEdgePolicyCatalog,
  resolveDrawioEdgeLabelStyleParts,
  resolveDrawioEdgeRoutingStyleParts,
} from './media-drawio-edge-policy.js';

describe('media-drawio-edge-policy', () => {
  it('uses the canonical catalog without a duplicated fallback definition', () => {
    const source = safeReadFile(
      pathResolver.rootResolve('libs/shared-media/src/media-drawio-edge-policy.ts'),
      {
        encoding: 'utf8',
      }
    ) as string;
    expect(source).not.toContain('FALLBACK_CATALOG');
  });

  it('resolves edge label and routing styles from knowledge', () => {
    const catalog = loadMediaDrawioEdgePolicyCatalog();

    expect(catalog.edge_labels.length).toBeGreaterThan(0);
    expect(resolveDrawioEdgeLabelStyleParts('source')).toContain('endArrow=open');
    expect(
      resolveDrawioEdgeRoutingStyleParts({ sourceTier: 'security', targetTier: 'web' })
    ).toEqual(['exitX=0', 'exitY=0.5', 'entryX=1', 'entryY=0.5']);
  });
});
