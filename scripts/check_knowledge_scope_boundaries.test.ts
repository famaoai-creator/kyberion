import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  countDirectTenantEnvReads,
  findKnowledgeScopeViolations,
  findKnowledgeRuntimeWriterViolations,
  scanKnowledgeScopeBoundaries,
} from './check_knowledge_scope_boundaries.js';

describe('knowledge scope semantic checker', () => {
  it('uses the foundation text reader for scope source files', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_knowledge_scope_boundaries.ts'), {
        encoding: 'utf8',
      }) || ''
    );
    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
  });

  it('detects an unscoped index and confidential literal', () => {
    const findings = findKnowledgeScopeViolations(
      "buildScopedIndex(); const input = { scope: { tier: 'confidential' } };",
      'fixture.ts'
    );
    expect(findings).toEqual([
      expect.stringContaining('unscoped buildScopedIndex'),
      expect.stringContaining('confidential scope literal'),
    ]);
  });

  it('accepts a tenant-bound confidential scope and counts direct env reads', () => {
    const source =
      "const scope = { tier: 'confidential', tenant_slug: 'tenant-a' };\nprocess.env.KYBERION_TENANT";
    expect(findKnowledgeScopeViolations(source, 'fixture.ts')).toEqual([]);
    expect(countDirectTenantEnvReads(source)).toBe(1);
  });

  it('fails the ratchet when direct tenant reads increase', () => {
    const findings = scanKnowledgeScopeBoundaries(
      [{ file: 'fixture.ts', source: 'process.env.KYBERION_TENANT\nprocess.env.KYBERION_TENANT' }],
      { max_direct_tenant_env_reads: 1 }
    );
    expect(findings).toContain(
      'process.env.KYBERION_TENANT direct reads increased beyond baseline: 2 > 1'
    );
  });

  it('ratchets listed scoped runtime writers onto physical namespaces', () => {
    expect(
      findKnowledgeRuntimeWriterViolations(
        [{ file: 'fixture.ts', source: 'safeWriteFile(path)' }],
        { max_direct_tenant_env_reads: 26, scoped_runtime_writer_files: ['fixture.ts'] }
      )
    ).toContain('fixture.ts: scoped runtime writer must use physicalScopedPath');
    expect(
      findKnowledgeRuntimeWriterViolations(
        [{ file: 'fixture.ts', source: 'physicalScopedPath(base, scope)' }],
        { max_direct_tenant_env_reads: 26, scoped_runtime_writer_files: ['fixture.ts'] }
      )
    ).toEqual([]);
  });
});
