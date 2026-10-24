import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '../libs/core/authority.js';
import { pathResolver } from '../libs/core/path-resolver.js';
import { safeRmSync, safeWriteFile } from '../libs/core/secure-io.js';
import {
  registerMemoryProvenance,
  revokeMemorySource,
  verifyMemoryOrigin,
} from '../libs/core/knowledge/memory-provenance.js';
import {
  runExternalOperationSync,
  withOperationArgumentOrigins,
  withOperationInterface,
} from '../libs/core/governance/external-operation.js';
import { computeApprovalPayloadHash } from '../libs/core/governance/approval-store.js';
import { KnowledgeHintIndex, queryKnowledge } from '../libs/core/knowledge/knowledge-index.js';

const owned = new Set<string>();
const governed = <T>(body: () => T) =>
  withExecutionContext('mission_controller', body, 'ecosystem_architect');
afterEach(() =>
  governed(() => {
    for (const file of owned) safeRmSync(file, { recursive: true, force: true });
    owned.clear();
  })
);

function fixture() {
  const tenant = 'prov-integrated-' + randomUUID().slice(0, 8);
  const scope = { tier: 'confidential' as const, tenant_slug: tenant };
  const root = 'knowledge/confidential/' + tenant;
  owned.add(pathResolver.rootResolve(root));
  owned.add(pathResolver.rootResolve('active/shared/runtime/tenants/' + tenant));
  const write = (name: string, text: string) => {
    const documentPath = root + '/evolution/' + name + '.md';
    safeWriteFile(documentPath, text);
    return registerMemoryProvenance({ scope, documentPath });
  };
  return { scope, root, write };
}

describe('provenance authorization across retrieval and commit', () => {
  it('prevents a source family from saturating top-k while retaining independent evidence', () =>
    governed(() => {
      const f = fixture();
      const source = f.write('source', 'Original approval evidence');
      const records = [source];
      for (let i = 0; i < 20; i++) {
        const file = f.root + '/evolution/summary-' + i + '.md';
        safeWriteFile(file, 'Paraphrase ' + i);
        records.push(
          registerMemoryProvenance({ scope: f.scope, documentPath: file, origins: [source] })
        );
      }
      records.push(f.write('independent', 'Independent approval evidence'));
      const index = new KnowledgeHintIndex(
        records.map((record) => ({
          topic: 'approval evidence',
          hint: 'approval evidence',
          confidence: 1,
          source: record.document_path.slice('knowledge/'.length),
          source_sha256: record.sha256,
        }))
      );
      const selected = queryKnowledge(index, 'approval evidence', {
        scopeContext: f.scope,
        maxResults: 5,
      });
      expect(records).toHaveLength(22);
      expect(selected).toHaveLength(2);
      expect(selected.some((hint) => hint.source.includes('independent'))).toBe(true);
      // Reuse the exact same cached index, with no reindex or descriptor rewrite.
      revokeMemorySource(f.scope, source.source_id, 'Verified correction');
      const after = queryKnowledge(index, 'approval evidence', {
        scopeContext: f.scope,
        maxResults: 5,
      });
      expect(after).toHaveLength(1);
      expect(after[0]!.source).toContain('independent');
    }));

  it.each(['unchanged', 'interface', 'arguments', 'revocation'] as const)(
    'checks %s state at the actual synchronous commit boundary',
    (change) =>
      governed(() => {
        const f = fixture();
        const source = f.write('approved-target', 'Approved exact destination');
        const checkpoint = structuredClone(source);
        const effect = { params: { url: 'https://example.invalid/reviewed' } };
        const operation = { operationId: 'browser:navigate', effect, requiresApproval: false };
        const execute = vi.fn(() => 'executed');
        let reads = 0;
        const run = () =>
          withOperationArgumentOrigins(
            [
              {
                path: ['params', 'url'],
                value_hash: computeApprovalPayloadHash({ value: effect.params.url }),
                authority: 'user',
                source: {
                  scope: f.scope,
                  source_id: source.source_id,
                  generation: source.generation,
                  sha256: source.sha256,
                },
              },
            ],
            () =>
              withOperationInterface(
                () => {
                  reads++;
                  if (reads === 2 && change === 'arguments')
                    effect.params.url = 'https://example.invalid/changed';
                  if (reads === 2 && change === 'revocation')
                    revokeMemorySource(f.scope, source.source_id, 'Source withdrawn');
                  return {
                    tool: 'browser:navigate',
                    schema_digest:
                      reads > 1 && change === 'interface' ? 'changed-schema' : 'reviewed-schema',
                    capability_digest: 'reviewed-capabilities',
                    candidate_set: ['navigate'],
                  };
                },
                () => runExternalOperationSync(operation, execute, () => 'succeeded')
              )
          );
        if (change === 'unchanged') {
          expect(run()).toBe('executed');
          expect(execute).toHaveBeenCalledTimes(1);
        } else {
          expect(run).toThrow(/PROTECTION_CHANGED/);
          expect(execute).not.toHaveBeenCalled();
        }
        if (change === 'revocation')
          expect(verifyMemoryOrigin({ ...checkpoint, scope: f.scope })).toBe(false);
      })
  );
});
