import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withExecutionContext, withExecutionContextAsync } from '../authority.js';
import { safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import {
  registerMemoryProvenance,
  revokeMemorySource,
  verifyMemoryOrigin,
  resolveMemoryEligibility,
  selectIndependentMemory,
} from './memory-provenance.js';
import { KnowledgeHintIndex, queryKnowledge, queryKnowledgeHybrid } from './knowledge-index.js';
import { findRelevantDistilledKnowledge } from './distill-knowledge-injector.js';
import {
  memoryProvenanceStatePath,
  MEMORY_PROVENANCE_READER_ROLE,
} from './memory-provenance-capability.js';
import { savePromotedMemoryRecord } from '../promoted-memory.js';
import { createDistillCandidateRecord } from './distill-candidate-registry.js';
import { registerEmbeddingBackend, resetEmbeddingBackend } from '../embedding-backend.js';

const cleanup = new Set<string>();
afterEach(() =>
  withExecutionContext(
    'mission_controller',
    () => {
      for (const file of cleanup) safeRmSync(file, { recursive: true, force: true });
      cleanup.clear();
      resetEmbeddingBackend();
    },
    'ecosystem_architect'
  )
);
function fixture() {
  const tenant = 'lineage-' + randomUUID().slice(0, 8);
  const scope = { tier: 'confidential' as const, tenant_slug: tenant };
  const root = 'knowledge/confidential/' + tenant;
  cleanup.add(pathResolver.rootResolve(root));
  cleanup.add(pathResolver.rootResolve('active/shared/runtime/tenants/' + tenant));
  const write = (name: string, body = 'Memory lineage relevant fact') => {
    const file = root + '/evolution/' + name;
    safeWriteFile(file, body);
    return file;
  };
  return { scope, root, write };
}
const governed = <T>(run: () => T) =>
  withExecutionContext('mission_controller', run, 'ecosystem_architect');

describe('memory lineage and current-use eligibility', () => {
  it('deduplicates source descendants while retaining independent corroboration', () =>
    governed(() => {
      const f = fixture();
      const original = registerMemoryProvenance({
        scope: f.scope,
        documentPath: f.write('source.md'),
      });
      const one = registerMemoryProvenance({
        scope: f.scope,
        documentPath: f.write('summary-a.md', 'First paraphrase'),
        origins: [original],
      });
      const two = registerMemoryProvenance({
        scope: f.scope,
        documentPath: f.write('summary-b.md', 'Second paraphrase'),
        origins: [original],
      });
      const independent = registerMemoryProvenance({
        scope: f.scope,
        documentPath: f.write('independent.md', 'Independently observed'),
      });
      expect(
        selectIndependentMemory([one, two, independent], (record) => record.source_families)
      ).toEqual([one, independent]);
    }));
  it('rejects transitive descendants after source revocation even with an old checkpoint descriptor', () =>
    governed(() => {
      const f = fixture();
      const source = registerMemoryProvenance({
        scope: f.scope,
        documentPath: f.write('source.md'),
      });
      const summary = registerMemoryProvenance({
        scope: f.scope,
        documentPath: f.write('summary.md'),
        origins: [source],
      });
      const descendant = registerMemoryProvenance({
        scope: f.scope,
        documentPath: f.write('descendant.md'),
        origins: [summary],
      });
      const restored = JSON.parse(JSON.stringify(descendant));
      expect(verifyMemoryOrigin({ ...restored, scope: f.scope })).toBe(true);
      revokeMemorySource(f.scope, source.source_id, 'Source corrected');
      expect(verifyMemoryOrigin({ ...restored, scope: f.scope })).toBe(false);
      expect(
        resolveMemoryEligibility({
          scope: f.scope,
          documentPath: descendant.document_path,
          sha256: descendant.sha256,
        })
      ).toEqual({ eligible: false });
      expect(() =>
        registerMemoryProvenance({ scope: f.scope, documentPath: source.document_path })
      ).toThrow('cannot resurrect');
    }));
  it('invalidates old versions on correction and retains unrelated sources', () =>
    governed(() => {
      const f = fixture();
      const file = f.write('source.md', 'Wrong fact');
      const source = registerMemoryProvenance({ scope: f.scope, documentPath: file });
      const unrelated = registerMemoryProvenance({
        scope: f.scope,
        documentPath: f.write('other.md'),
      });
      safeWriteFile(file, 'Correct fact');
      const corrected = registerMemoryProvenance({ scope: f.scope, documentPath: file });
      expect(corrected.source_families).toEqual(source.source_families);
      expect(verifyMemoryOrigin({ ...source, scope: f.scope })).toBe(false);
      expect(verifyMemoryOrigin({ ...corrected, scope: f.scope })).toBe(true);
      expect(verifyMemoryOrigin({ ...unrelated, scope: f.scope })).toBe(true);
    }));
  it('refuses cross-tenant refs, scope relabelling and self-derived replacement', () =>
    governed(() => {
      const f = fixture();
      const file = f.write('source.md');
      const source = registerMemoryProvenance({ scope: f.scope, documentPath: file });
      expect(
        verifyMemoryOrigin({ ...source, scope: { ...f.scope, tenant_slug: 'other-tenant' } })
      ).toBe(false);
      expect(() =>
        registerMemoryProvenance({ scope: { tier: 'public' }, documentPath: file })
      ).toThrow('SCOPE');
      safeWriteFile(file, 'New summary');
      expect(() =>
        registerMemoryProvenance({ scope: f.scope, documentPath: file, origins: [source] })
      ).toThrow('Invalid parent');
    }));
  it.each([
    { organization_id: 'org-probe', project_id: 'project-probe' },
    { mission_id: 'MSN-CONTEXT-A' },
    { mission_id: 'MSN-CONTEXT-A', task_id: 'TASK-CONTEXT-A' },
  ])(
    'keeps revoked source tombstones across narrower use contexts $mission_id $project_id $task_id',
    (context) =>
      governed(() => {
        const f = fixture();
        const file = f.write('source.md');
        const original = registerMemoryProvenance({ scope: f.scope, documentPath: file });
        const scoped = registerMemoryProvenance({
          scope: { ...f.scope, ...context },
          documentPath: file,
        });
        expect(scoped.source_families).toEqual(original.source_families);
        revokeMemorySource(f.scope, original.source_id, 'Revoked at its canonical source');
        expect(verifyMemoryOrigin({ ...scoped, scope: scoped.scope })).toBe(false);
        expect(() =>
          registerMemoryProvenance({
            scope: {
              ...f.scope,
              ...context,
              mission_id: context.mission_id || 'MSN-NEW',
              task_id: context.task_id || 'TASK-NEW',
              session_id: 'SESSION-NEW',
            },
            documentPath: file,
          })
        ).toThrow('cannot resurrect');
      })
  );
  it('invalidates old contextual versions on correction even if their exact bytes are restored', () =>
    governed(() => {
      const f = fixture();
      const file = f.write('source.md', 'Original source bytes');
      const original = registerMemoryProvenance({ scope: f.scope, documentPath: file });
      const projectScope = {
        ...f.scope,
        organization_id: 'org-probe',
        project_id: 'project-probe',
      };
      safeWriteFile(file, 'Corrected source bytes');
      const corrected = registerMemoryProvenance({ scope: projectScope, documentPath: file });
      expect(corrected.source_families).toEqual(original.source_families);
      safeWriteFile(file, 'Original source bytes');
      expect(verifyMemoryOrigin({ ...original, scope: f.scope })).toBe(false);
      expect(
        resolveMemoryEligibility({ scope: f.scope, documentPath: file, sha256: original.sha256 })
          .eligible
      ).toBe(false);
      expect(() => registerMemoryProvenance({ scope: projectScope, documentPath: file })).toThrow(
        'cannot resurrect'
      );
    }));
  it('preserves ancestry when the same artifact is admitted to a narrower context', () =>
    governed(() => {
      const f = fixture();
      const root = registerMemoryProvenance({ scope: f.scope, documentPath: f.write('root.md') });
      const file = f.write('summary.md');
      const original = registerMemoryProvenance({
        scope: f.scope,
        documentPath: file,
        origins: [root],
      });
      const scoped = registerMemoryProvenance({
        scope: { ...f.scope, mission_id: 'MSN-NARROW', task_id: 'TASK-NARROW' },
        documentPath: file,
      });
      expect(scoped.origins).toEqual(original.origins);
      expect(scoped.source_families).toEqual(original.source_families);
      revokeMemorySource(f.scope, root.source_id, 'Original evidence retracted');
      expect(verifyMemoryOrigin({ ...scoped, scope: scoped.scope })).toBe(false);
    }));
  it('never treats revoked broad history as a grant to widen a corrected source', () =>
    governed(() => {
      const f = fixture();
      const file = f.write('source.md', 'Initial tenant source');
      registerMemoryProvenance({ scope: f.scope, documentPath: file });
      const projectScope = {
        ...f.scope,
        organization_id: 'org-ceiling',
        project_id: 'project-ceiling',
      };
      safeWriteFile(file, 'Project-restricted correction');
      const corrected = registerMemoryProvenance({ scope: projectScope, documentPath: file });
      // Unchanged exact identity is still idempotent, without a new scope grant.
      expect(registerMemoryProvenance({ scope: projectScope, documentPath: file }).source_id).toBe(
        corrected.source_id
      );
      safeWriteFile(file, 'Attempted broader third version');
      expect(() => registerMemoryProvenance({ scope: f.scope, documentPath: file })).toThrow(
        'restrictions cannot be widened'
      );
      const taskScope = { ...projectScope, mission_id: 'MSN-CEILING', task_id: 'TASK-CEILING' };
      const narrower = registerMemoryProvenance({ scope: taskScope, documentPath: file });
      expect(verifyMemoryOrigin({ ...narrower, scope: taskScope })).toBe(true);
    }));
  it('retains a restrictive source ceiling after explicit revocation', () =>
    governed(() => {
      const f = fixture();
      const projectScope = {
        ...f.scope,
        organization_id: 'org-ceiling',
        project_id: 'project-ceiling',
      };
      const file = f.write('source.md', 'Project-only source');
      const original = registerMemoryProvenance({ scope: projectScope, documentPath: file });
      revokeMemorySource(projectScope, original.source_id, 'Explicit source revocation');
      safeWriteFile(file, 'Different bytes do not grant broader scope');
      expect(() => registerMemoryProvenance({ scope: f.scope, documentPath: file })).toThrow(
        'restrictions cannot be widened'
      );
      const narrowerScope = {
        ...projectScope,
        mission_id: 'MSN-REVIEWED',
        task_id: 'TASK-REVIEWED',
      };
      const narrower = registerMemoryProvenance({ scope: narrowerScope, documentPath: file });
      expect(verifyMemoryOrigin({ ...narrower, scope: narrowerScope })).toBe(true);
    }));
  it('uses one external source family across missions without merging tenants or widening scope', () =>
    governed(() => {
      const f = fixture();
      const oneScope = { ...f.scope, mission_id: 'MSN-FIRST' };
      const twoScope = { ...f.scope, mission_id: 'MSN-SECOND', task_id: 'TASK-SECOND' };
      const ref = 'https://example.com/context-independent-source';
      const first = registerMemoryProvenance({
        scope: oneScope,
        documentPath: f.write('first.md'),
        sourceRefs: [ref],
      });
      const second = registerMemoryProvenance({
        scope: twoScope,
        documentPath: f.write('second.md'),
        sourceRefs: [ref],
      });
      expect(first.source_families).toEqual(second.source_families);
      expect(first.origins).toEqual(second.origins);
      expect(
        resolveMemoryEligibility({
          scope: f.scope,
          consumerScope: twoScope,
          documentPath: first.document_path,
          sha256: first.sha256,
        }).eligible
      ).toBe(false);
      const other = fixture();
      const independentTenant = registerMemoryProvenance({
        scope: other.scope,
        documentPath: other.write('other.md'),
        sourceRefs: [ref],
      });
      expect(independentTenant.source_families).not.toEqual(first.source_families);
      revokeMemorySource(
        f.scope,
        first.origins[0].source_id,
        'Source globally retracted in its tenant'
      );
      expect(verifyMemoryOrigin({ ...second, scope: twoScope })).toBe(false);
      expect(() =>
        registerMemoryProvenance({
          scope: { ...f.scope, mission_id: 'MSN-THIRD' },
          documentPath: f.write('third.md'),
          sourceRefs: [ref],
        })
      ).toThrow('Invalid parent');
      expect(verifyMemoryOrigin({ ...independentTenant, scope: other.scope })).toBe(true);
    }));
  it('does not let an ordinary worker mutate authoritative lineage', () => {
    expect(() =>
      withExecutionContext('worker', () =>
        registerMemoryProvenance({ scope: { tier: 'public' }, documentPath: 'AGENTS.md' })
      )
    ).toThrow('AUTHORITY');
  });
  it.each([
    { field: 'source_families', value: [] },
    { field: 'source_families', value: ['forged-family'] },
    { field: 'source_families', value: [null] },
    { field: 'origins', value: [{ source_id: 'forged', sha256: 'bad', generation: -1 }] },
  ])('fails closed on malformed authoritative $field', ({ field, value }) =>
    governed(() => {
      const f = fixture();
      const source = registerMemoryProvenance({
        scope: f.scope,
        documentPath: f.write('source.md'),
      });
      const file = memoryProvenanceStatePath(f.scope);
      const state = JSON.parse(String(safeReadFile(file, { encoding: 'utf8' }))) as {
        records: Record<string, Record<string, unknown>>;
      };
      state.records[source.source_id][field] = value;
      safeWriteFile(file, JSON.stringify(state));
      expect(
        resolveMemoryEligibility({
          scope: f.scope,
          documentPath: source.document_path,
          sha256: source.sha256,
        })
      ).toEqual({ eligible: false });
      expect(verifyMemoryOrigin({ ...source, scope: f.scope })).toBe(false);
    })
  );
  it('permits a public worker lookup but rejects direct writes and a bare reader role', () =>
    governed(() => {
      const scope = { tier: 'public' as const };
      const file = 'knowledge/public/evolution/lineage-' + randomUUID() + '.md';
      cleanup.add(pathResolver.rootResolve(file));
      safeWriteFile(file, 'Public independent evidence');
      const record = registerMemoryProvenance({ scope, documentPath: file });
      expect(
        withExecutionContext('worker', () =>
          resolveMemoryEligibility({ scope, documentPath: file, sha256: record.sha256 })
        ).eligible
      ).toBe(true);
      expect(() =>
        withExecutionContext('worker', () => safeWriteFile(memoryProvenanceStatePath(scope), '{}'))
      ).toThrow('outside worker-mutable');
      expect(() => withExecutionContext(MEMORY_PROVENANCE_READER_ROLE, () => undefined)).toThrow(
        'read capability'
      );
    }));
  it('refuses an ordinary reader attempting another tenant partition', () =>
    governed(() => {
      const f = fixture();
      const file = f.write('source.md');
      const source = registerMemoryProvenance({ scope: f.scope, documentPath: file });
      const result = withExecutionContext(
        'worker',
        () =>
          resolveMemoryEligibility({ scope: f.scope, documentPath: file, sha256: source.sha256 }),
        'worker',
        'other-tenant'
      );
      expect(result.eligible).toBe(false);
    }));
  it('rechecks ancestor bytes when querying a restored index even without a revocation event', () =>
    governed(() => {
      const f = fixture();
      const file = f.write('root.md');
      const root = registerMemoryProvenance({ scope: f.scope, documentPath: file });
      const derived = registerMemoryProvenance({
        scope: f.scope,
        documentPath: f.write('derived.md'),
        origins: [root],
      });
      const index = new KnowledgeHintIndex([
        {
          topic: 'lineage',
          hint: 'lineage',
          confidence: 1,
          source: derived.document_path.slice('knowledge/'.length),
          source_sha256: derived.sha256,
        },
      ]);
      expect(queryKnowledge(index, 'lineage', { scopeContext: f.scope })).toHaveLength(1);
      safeWriteFile(file, 'Source has changed without a registration ceremony');
      expect(queryKnowledge(index, 'lineage', { scopeContext: f.scope })).toHaveLength(0);
      expect(verifyMemoryOrigin({ ...derived, scope: f.scope })).toBe(false);
    }));
  it('never erases or silently changes immutable ancestry for identical bytes', () =>
    governed(() => {
      const f = fixture();
      const root = registerMemoryProvenance({ scope: f.scope, documentPath: f.write('root.md') });
      const file = f.write('derived.md');
      const derived = registerMemoryProvenance({
        scope: f.scope,
        documentPath: file,
        origins: [root],
      });
      expect(registerMemoryProvenance({ scope: f.scope, documentPath: file }).origins).toEqual(
        derived.origins
      );
      expect(() =>
        registerMemoryProvenance({ scope: f.scope, documentPath: file, origins: [] })
      ).toThrow('CONFLICT');
    }));
  it('deduplicates real published paraphrases of one reviewed external source', () =>
    governed(() => {
      const outputs = ['First observation', 'Second paraphrase'].map((title) => {
        const candidate = createDistillCandidateRecord({
          source_type: 'artifact',
          tier: 'public',
          title,
          summary:
            title + ' supplies a complete independently reviewable source lineage observation.',
          target_kind: 'pattern',
          evidence_refs: ['https://example.com/lineage-paper'],
          metadata: {
            knowledge_domain: 'product',
            applicability: ['memory'],
            reusable_steps: ['Check source lineage'],
            expected_outcome: 'Independent evidence',
          },
        });
        // Product publication itself restricts evidence paths; organization/public
        // records use the same governed publisher and may cite reviewed URLs.
        candidate.metadata!.knowledge_domain = 'organization';
        const output = savePromotedMemoryRecord(candidate);
        cleanup.add(pathResolver.rootResolve(output.logicalPath));
        cleanup.add(pathResolver.rootResolve(output.logicalPath.replace(/\.md$/, '.json')));
        const proof = registerMemoryProvenance({
          scope: { tier: 'public' },
          documentPath: output.logicalPath,
        });
        return { ...proof, title };
      });
      const index = new KnowledgeHintIndex(
        outputs.map((record) => ({
          topic: 'external lineage',
          hint: record.title,
          confidence: 1,
          source: record.document_path.slice('knowledge/'.length),
          source_sha256: record.sha256,
        }))
      );
      expect(queryKnowledge(index, 'external lineage')).toHaveLength(1);
      const externalOrigin = outputs[0].origins[0];
      expect(verifyMemoryOrigin({ ...externalOrigin, scope: { tier: 'public' } })).toBe(false);
      revokeMemorySource({ tier: 'public' }, externalOrigin.source_id, 'External source retracted');
      expect(queryKnowledge(index, 'external lineage')).toHaveLength(0);
    }));
  it('filters cached index hits after revocation without rebuilding the index', async () => {
    const data = governed(() => {
      const f = fixture();
      const source = registerMemoryProvenance({
        scope: f.scope,
        documentPath: f.write('source.md'),
      });
      const summary = registerMemoryProvenance({
        scope: f.scope,
        documentPath: f.write('summary.md'),
        origins: [source],
      });
      const independent = registerMemoryProvenance({
        scope: f.scope,
        documentPath: f.write('other.md'),
      });
      const index = new KnowledgeHintIndex(
        [source, summary, independent].map((record) => ({
          topic: 'Memory lineage',
          hint: 'Memory lineage fact',
          confidence: 1,
          source: record.document_path.slice('knowledge/'.length),
          source_sha256: record.sha256,
        }))
      );
      return { f, source, index };
    });
    const options = { maxResults: 10, scopeContext: data.f.scope };
    expect(governed(() => queryKnowledge(data.index, 'Memory lineage', options))).toHaveLength(2);
    governed(() => revokeMemorySource(data.f.scope, data.source.source_id, 'Untrusted source'));
    expect(governed(() => queryKnowledge(data.index, 'Memory lineage', options))).toHaveLength(1);
    expect(
      await withExecutionContextAsync(
        'mission_controller',
        () => queryKnowledgeHybrid(data.index, 'Memory lineage', options),
        'ecosystem_architect'
      )
    ).toHaveLength(1);
  });
  it.each([false, true])(
    'revalidates distilled eligibility after in-flight revocation (embedding fails: %s)',
    async (fail) => {
      const data = governed(() => {
        const f = fixture();
        const root = registerMemoryProvenance({ scope: f.scope, documentPath: f.write('root.md') });
        const file = f.write(
          'distill_async.md',
          '---\ntitle: Inflight memory probe\ntags: [inflight-memory-probe]\n---\n\nA useful finding'
        );
        registerMemoryProvenance({ scope: f.scope, documentPath: file, origins: [root] });
        return { f, root };
      });
      registerEmbeddingBackend({
        name: 'inflight-revoke',
        dimensions: 2,
        quality: 'semantic',
        embed: async () => {
          governed(() =>
            revokeMemorySource(data.f.scope, data.root.source_id, 'Revoked while embedding')
          );
          await Promise.resolve();
          if (fail) throw new Error('Embedding unavailable after revocation');
          return new Float32Array([1, 0]);
        },
        embedBatch: async (texts) => texts.map(() => new Float32Array([1, 0])),
      });
      const results = await withExecutionContextAsync(
        'mission_controller',
        () =>
          findRelevantDistilledKnowledge({
            topic: 'Inflight memory probe',
            tags: ['inflight-memory-probe'],
            scope: data.f.scope,
            limit: 10,
          }),
        'ecosystem_architect'
      );
      expect(results.filter((entry) => entry.path.startsWith(data.f.root))).toHaveLength(0);
    }
  );
  it('applies family selection and revocation to real distilled retrieval', async () => {
    const data = governed(() => {
      const f = fixture();
      const root = registerMemoryProvenance({ scope: f.scope, documentPath: f.write('root.md') });
      for (const name of ['distill_first.md', 'distill_second.md']) {
        const file = f.write(
          name,
          '---\ntitle: Lineage memory probe\ntags: [lineage-memory-probe]\n---\n\n' + name
        );
        registerMemoryProvenance({ scope: f.scope, documentPath: file, origins: [root] });
      }
      return { f, root };
    });
    const query = {
      topic: 'Lineage memory probe',
      tags: ['lineage-memory-probe'],
      scope: data.f.scope,
      limit: 10,
    };
    const before = await withExecutionContextAsync(
      'mission_controller',
      () => findRelevantDistilledKnowledge(query),
      'ecosystem_architect'
    );
    expect(before.filter((entry) => entry.path.startsWith(data.f.root))).toHaveLength(1);
    governed(() => revokeMemorySource(data.f.scope, data.root.source_id, 'Superseded'));
    const after = await withExecutionContextAsync(
      'mission_controller',
      () => findRelevantDistilledKnowledge(query),
      'ecosystem_architect'
    );
    expect(after.filter((entry) => entry.path.startsWith(data.f.root))).toHaveLength(0);
  });
});
