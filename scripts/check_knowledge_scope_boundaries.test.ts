import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  countDirectTenantEnvReads,
  findKnowledgeScopeViolations,
  findKnowledgeRuntimeWriterViolations,
  readKnowledgeScopeTextFile,
  scanKnowledgeScopeBoundaries,
} from './check_knowledge_scope_boundaries.js';

describe('knowledge scope semantic checker', () => {
  it('rejects a directory replacement before scope scanning', () => {
    expect(() => readKnowledgeScopeTextFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });

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
    ).toContain(
      'fixture.ts: scoped runtime writer must use physicalScopedPath or scoped runtimeStatePath physicalPath'
    );
    expect(
      findKnowledgeRuntimeWriterViolations(
        [
          {
            file: 'fixture.ts',
            source:
              "import { physicalScopedPath } from '../physical-namespace.js'; physicalScopedPath(base, scope)",
          },
        ],
        { max_direct_tenant_env_reads: 26, scoped_runtime_writer_files: ['fixture.ts'] }
      )
    ).toEqual([]);
  });

  it('accepts scoped canonical registry placement, including an import alias', () => {
    const config = { max_direct_tenant_env_reads: 26, scoped_runtime_writer_files: ['fixture.ts'] };
    expect(
      findKnowledgeRuntimeWriterViolations(
        [
          {
            file: 'fixture.ts',
            source: `
      import { runtimeStatePath as placement } from '../foundation/runtime-state-roots.js';
      const path = placement('memory.promotionQueue', scope).physicalPath;
    `,
          },
        ],
        config
      )
    ).toEqual([]);
    for (const expression of [
      "runtimeStatePath('memory.promotionQueue').physicalPath",
      "runtimeStatePath('memory.promotionQueue', undefined).physicalPath",
      "runtimeStatePath('memory.promotionQueue', scope).logicalPath",
      "runtimeStatePath('dot.wakeLedger', scope).physicalPath",
    ]) {
      expect(
        findKnowledgeRuntimeWriterViolations(
          [
            {
              file: 'fixture.ts',
              source: `
        import { runtimeStatePath } from '../foundation/runtime-state-roots.js';
        const path = ${expression};
      `,
            },
          ],
          config
        )
      ).toHaveLength(1);
    }
  });

  it('does not accept dummy strings/comments, unrelated helpers or unused imports', () => {
    const config = { max_direct_tenant_env_reads: 26, scoped_runtime_writer_files: ['fixture.ts'] };
    for (const source of [
      "// physicalScopedPath(base, scope)\nconst name = 'runtimeStatePath';",
      "import { physicalScopedPath } from '../untrusted.js'; physicalScopedPath(base, scope)",
      "import { runtimeStatePath } from '../foundation/runtime-state-roots.js'; safeWriteFile(path, data)",
    ])
      expect(
        findKnowledgeRuntimeWriterViolations([{ file: 'fixture.ts', source }], config)
      ).toHaveLength(1);
  });
});
