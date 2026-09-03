import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { loadKnowledgeScopeCheckPolicy } from './knowledge-scope-check-policy.js';

describe('knowledge-scope-check-policy', () => {
  const filePath = pathResolver.sharedTmp('knowledge-scope-check-policy-test.json');

  beforeEach(() => {
    safeRmSync(filePath, { force: true });
  });

  afterEach(() => {
    safeRmSync(filePath, { recursive: true, force: true });
  });

  it('loads the schema-valid policy through the governed catalog', () => {
    safeWriteFile(
      filePath,
      JSON.stringify({
        version: '1.0.0',
        description: 'test policy',
        max_direct_tenant_env_reads: 26,
        legacy_quarantine_ttl_days: 14,
        confidential_scope_allowlist: [],
        scoped_runtime_writer_files: ['libs/core/example.ts'],
      })
    );

    expect(loadKnowledgeScopeCheckPolicy(filePath)).toMatchObject({
      max_direct_tenant_env_reads: 26,
      legacy_quarantine_ttl_days: 14,
    });
  });

  it('returns null for invalid or non-file policy state', () => {
    safeWriteFile(
      filePath,
      JSON.stringify({
        version: '1.0.0',
        description: 'test policy',
        max_direct_tenant_env_reads: 26,
        legacy_quarantine_ttl_days: 14,
        confidential_scope_allowlist: [],
        scoped_runtime_writer_files: [],
        unexpected: true,
      })
    );
    expect(loadKnowledgeScopeCheckPolicy(filePath)).toBeNull();

    safeRmSync(filePath, { force: true });
    safeMkdir(filePath, { recursive: true });
    expect(loadKnowledgeScopeCheckPolicy(filePath)).toBeNull();
  });
});
