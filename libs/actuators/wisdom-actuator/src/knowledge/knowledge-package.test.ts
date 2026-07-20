import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { resetA2ASecretCache } from '@agent/core';
import {
  assertKnowledgePackage,
  assertKnowledgePackageOriginScope,
  assertKnowledgePackageTrusted,
  createKnowledgePackage,
} from './knowledge-package.js';

function makePackage() {
  const rawData = 'decision evidence';
  return createKnowledgePackage({
    packageId: 'KKP-test-1',
    originAgentId: 'agent-test',
    originTenantId: 'tenant-test',
    sourceTier: 'confidential',
    requestedTargetTier: 'confidential',
    contentHash: createHash('sha256').update(rawData).digest('hex'),
    createdAt: '2026-07-20T00:00:00.000Z',
    provenance: ['knowledge/confidential/project/evidence.md'],
    contentPath: 'knowledge/confidential/project/evidence.md',
    rawData,
  });
}

describe('knowledge package trust boundary', () => {
  afterEach(() => {
    delete process.env.KYBERION_A2A_SECRET;
    resetA2ASecretCache();
  });

  it('creates and verifies a signed package', () => {
    process.env.KYBERION_A2A_SECRET = 'knowledge-package-test-secret';
    resetA2ASecretCache();
    const pkg = makePackage();

    expect(pkg.metadata.trust_status).toBe('verified');
    expect(pkg.metadata.signature.status).toBe('verified');
    expect(() => assertKnowledgePackageTrusted(pkg)).not.toThrow();
  });

  it('rejects a package that only claims trust without a valid signature', () => {
    const pkg = makePackage();
    const tampered = {
      ...pkg,
      content: { ...pkg.content, raw_data: 'tampered evidence' },
    };

    expect(() => assertKnowledgePackageTrusted(tampered)).toThrow(
      'KNOWLEDGE_PACKAGE_SIGNATURE_INVALID'
    );
  });

  it('rejects unverified packages even when their content hash is valid', () => {
    const pkg = makePackage();
    const unverified = {
      ...pkg,
      metadata: {
        ...pkg.metadata,
        trust_status: 'unverified' as const,
        signature: { status: 'absent' as const },
      },
    };

    expect(() => assertKnowledgePackageTrusted(unverified)).toThrow('KNOWLEDGE_PACKAGE_UNTRUSTED');
  });

  it('fails schema validation for traversal paths', () => {
    const pkg = makePackage();
    expect(() =>
      assertKnowledgePackage({
        ...pkg,
        content: { ...pkg.content, path: '../outside.txt' },
      })
    ).toThrow('KNOWLEDGE_PACKAGE_SCHEMA_INVALID');
  });

  it('fails closed when an import package origin does not match the execution scope', () => {
    const pkg = makePackage();
    expect(() => assertKnowledgePackageOriginScope(pkg, { tenantId: 'different-tenant' })).toThrow(
      'KNOWLEDGE_ORIGIN_SCOPE_MISMATCH'
    );
    expect(() => assertKnowledgePackageOriginScope(pkg, {})).toThrow(
      'KNOWLEDGE_ORIGIN_SCOPE_REQUIRED'
    );
  });
});
