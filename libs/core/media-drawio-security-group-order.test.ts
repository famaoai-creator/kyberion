import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  loadMediaDrawioSecurityGroupOrderCatalog,
  resolveMediaDrawioSecurityGroupRelationPrefix,
} from './media-drawio-security-group-order.js';

describe('media-drawio-security-group-order', () => {
  it('uses the canonical catalog without a duplicated fallback definition', () => {
    const source = safeReadFile(
      pathResolver.rootResolve('libs/core/media-drawio-security-group-order.ts'),
      { encoding: 'utf8' }
    ) as string;
    expect(source).not.toContain('FALLBACK_CATALOG');
  });

  it('resolves security group ordering prefix from knowledge', () => {
    const catalog = loadMediaDrawioSecurityGroupOrderCatalog();

    expect(catalog.relation_prefix).toBe('aws_security_group.');
    expect(resolveMediaDrawioSecurityGroupRelationPrefix()).toBe('aws_security_group.');
  });
});
