import { describe, expect, it } from 'vitest';
import {
  loadMediaDrawioSecurityGroupOrderCatalog,
  resolveMediaDrawioSecurityGroupRelationPrefix,
} from './media-drawio-security-group-order.js';

describe('media-drawio-security-group-order', () => {
  it('resolves security group ordering prefix from knowledge', () => {
    const catalog = loadMediaDrawioSecurityGroupOrderCatalog();

    expect(catalog.relation_prefix).toBe('aws_security_group.');
    expect(resolveMediaDrawioSecurityGroupRelationPrefix()).toBe('aws_security_group.');
  });
});
