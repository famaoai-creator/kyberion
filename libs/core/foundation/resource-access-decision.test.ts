import { describe, expect, it } from 'vitest';
import {
  decideResourceAccess,
  resourceAccessDenial,
  runInResourceAccessScope,
  type ResourceAccessOperation,
  type ResourceAccessScope,
} from './resource-access-scope.js';

const base = 'active/shared/runtime/example/confidential/acme';
const read = `${base}/read.json`;
const write = `${base}/write.json`;
const append = `${base}/append.jsonl`;
const directory = `${base}/directory`;
const scope: ResourceAccessScope = {
  tenantSlug: 'acme',
  readExact: [read],
  writeExact: [write],
  appendExact: [append],
  mkdirExact: [directory],
  metadataExact: [`${base}/metadata.json`],
};

describe('pure resource operation ceiling', () => {
  it.each([
    [read, 'read', true],
    [read, 'write', false],
    [read, 'append', false],
    [write, 'write', true],
    [write, 'append', true],
    [write, 'read', false],
    [append, 'append', true],
    [append, 'write', false],
    [append, 'read', false],
    [directory, 'mkdir', true],
    [directory, 'read', false],
    [directory, 'write', false],
    [base, 'metadata', true],
    ['', 'metadata', true],
    [read, 'metadata', true],
    [`${base}/metadata.json`, 'metadata', true],
    [`${base}/metadata.json`, 'read', false],
    [`${base}/sibling.json`, 'metadata', false],
    [`${read}/child`, 'metadata', false],
    [`${directory}/child`, 'mkdir', false],
  ] as const)('%s %s yields %s', (target, operation, allowed) => {
    expect(decideResourceAccess(scope, target, operation).allowed).toBe(allowed);
  });

  it.each([
    '../secret',
    '/etc/passwd',
    'active//file',
    'active/./file',
    'active/x/../file',
    'active/file/',
    'active\\file',
    'C:/secret',
    'active/*',
    'active/\0file',
    'active/$ROOT',
  ])('rejects noncanonical target %s', (target) => {
    expect(decideResourceAccess(scope, target, 'metadata')).toEqual({
      allowed: false,
      reason: 'invalid_path',
    });
  });

  it('does not let root metadata become root contents or mutation', () => {
    for (const operation of ['read', 'write', 'append', 'mkdir'] as const)
      expect(decideResourceAccess(scope, '', operation)).toEqual({
        allowed: false,
        reason: 'invalid_path',
      });
    expect(
      decideResourceAccess(
        { tenantSlug: 'acme', readExact: [], writeExact: [], mkdirExact: [] },
        '',
        'metadata'
      ).allowed
    ).toBe(false);
  });

  it('limits name prefixes to one component and never mkdir', () => {
    const prefixScope = { ...scope, namePrefixExact: [`${base}/staged-`] };
    for (const operation of ['read', 'write', 'append', 'metadata'] as const)
      expect(decideResourceAccess(prefixScope, `${base}/staged-1`, operation).allowed).toBe(true);
    for (const [target, operation] of [
      [`${base}/staged-1`, 'mkdir'],
      [`${base}/staged-`, 'read'],
      [`${base}/staged-1/child`, 'read'],
    ] as const)
      expect(decideResourceAccess(prefixScope, target, operation).allowed).toBe(false);
  });

  it('rejects unknown runtime operations even on metadata and name-prefix paths', () => {
    const prefixed = { ...scope, namePrefixExact: [`${base}/staged-`] };
    for (const target of [read, '', `${base}/staged-1`])
      for (const operation of ['delete', '', 'READ', undefined, null])
        expect(
          decideResourceAccess(prefixed, target, operation as ResourceAccessOperation)
        ).toEqual({ allowed: false, reason: 'invalid_operation' });
  });

  it('keeps optional product-knowledge reads separate from writes', () => {
    const productScope = { ...scope, allowProductKnowledgeRead: true };
    expect(
      decideResourceAccess(productScope, 'knowledge/product/schema.json', 'read').allowed
    ).toBe(true);
    for (const target of ['knowledge', 'knowledge/product', 'knowledge/product/schema.json'])
      expect(decideResourceAccess(productScope, target, 'metadata').allowed).toBe(true);
    expect(
      decideResourceAccess(productScope, 'knowledge/products/schema.json', 'read').allowed
    ).toBe(false);
    expect(
      decideResourceAccess(productScope, 'knowledge/product/schema.json', 'write').allowed
    ).toBe(false);
  });

  it('does not treat its pure allow as proof of grant identity or nested permission', () => {
    expect(decideResourceAccess(scope, append, 'append').allowed).toBe(true);
    expect(resourceAccessDenial(append, 'append')).toBeNull();
    runInResourceAccessScope({ ...scope, appendExact: [] }, () => {
      runInResourceAccessScope(scope, () => {
        expect(decideResourceAccess(scope, append, 'append').allowed).toBe(true);
        expect(resourceAccessDenial(append, 'append')).toMatchObject({ allowed: false });
        expect(resourceAccessDenial(read, 'delete' as ResourceAccessOperation)).toMatchObject({
          allowed: false,
        });
      });
    });
  });
});
