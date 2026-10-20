import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';
import {
  createDistillCandidateRecord,
  distillCandidateRecordPath,
  loadDistillCandidateRecord,
  saveDistillCandidateRecord,
} from './knowledge/distill-candidate-registry.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  loadMemoryPromotionCandidate,
} from './knowledge/memory-promotion-queue.js';
import type { MemoryScopeEnvelope } from './knowledge/memory-scope.js';
import { savePromotedMemoryRecord } from './promoted-memory.js';

const cleanup = new Set<string>();
afterEach(() => {
  withExecutionContext('ecosystem_architect', () => {
    for (const file of cleanup) safeRmSync(file, { recursive: true, force: true });
  });
  cleanup.clear();
});

const restrictions: Array<Partial<MemoryScopeEnvelope>> = [
  { owner_nhi: 'nhi:owner-only' },
  { allowed_audience: ['user:restricted-reader'] },
  { mission_id: 'MSN-RESTRICTED', task_id: 'TASK-RESTRICTED' },
];

describe('scoped publisher fail-closed boundary', () => {
  it.each(['pattern', 'knowledge_hint', 'report_template', 'procedure'] as const)(
    'refuses scoped organization %s before writing an artifact or changing the registry',
    (targetKind) => {
      for (const restriction of restrictions) {
        const tenant = 'publisher-' + randomUUID().slice(0, 8);
        const scope: MemoryScopeEnvelope = {
          tier: 'confidential',
          tenant_slug: tenant,
          ...restriction,
        };
        const candidate = createDistillCandidateRecord({
          source_type: 'task_session',
          tier: 'confidential',
          scope,
          title: 'Restricted reusable reconciliation procedure',
          summary:
            'Reconcile the source totals and preserve restricted evidence before producing the final report.',
          status: 'proposed',
          target_kind: targetKind,
          metadata: {
            knowledge_domain: 'organization',
            applicability: ['reconciliation'],
            reusable_steps: ['Compare source totals'],
            hint_scope: 'reconciliation',
            hint_triggers: ['mismatched totals'],
            template_sections: ['Source totals', 'Discrepancies'],
          },
        });
        const artifactRoot = pathResolver.knowledge('confidential/' + tenant);
        cleanup.add(artifactRoot);
        cleanup.add(pathResolver.rootResolve('active/shared/runtime/tenants/' + tenant));
        withExecutionContext('ecosystem_architect', () => saveDistillCandidateRecord(candidate));
        const recordPath = distillCandidateRecordPath(candidate.candidate_id, scope);
        const before = String(safeReadFile(recordPath, { encoding: 'utf8' }));
        expect(() => savePromotedMemoryRecord(candidate)).toThrow(
          '[LEARNING_SCOPE_UNSUPPORTED] Scoped organization publication supports canonical approved SOPs only'
        );
        expect(safeExistsSync(artifactRoot)).toBe(false);
        expect(String(safeReadFile(recordPath, { encoding: 'utf8' }))).toBe(before);
        expect(loadDistillCandidateRecord(candidate.candidate_id, scope)?.status).toBe('proposed');
        expect(loadDistillCandidateRecord(candidate.candidate_id)).toBeNull();
      }
    }
  );

  it('does not turn a public source queue row into an authorized confidential destination', () => {
    const root = pathResolver.sharedTmp('publisher-source-' + randomUUID());
    cleanup.add(root);
    const savedQueue = process.env.KYBERION_MEMORY_QUEUE_PATH;
    process.env.KYBERION_MEMORY_QUEUE_PATH = root + '/promotion-queue.jsonl';
    try {
      const scope = { tier: 'public' as const };
      const candidate = createMemoryPromotionCandidate({
        sourceType: 'task_session',
        sourceRef: 'mission:MSN-PUBLIC-SOURCE',
        knowledgeDomain: 'organization',
        proposedMemoryKind: 'sop',
        summary: 'Reconcile source totals before reporting an operating result.',
        evidenceRefs: ['mission:MSN-PUBLIC-SOURCE'],
        sensitivityTier: 'confidential',
        ratificationRequired: true,
        scope,
      });
      enqueueMemoryPromotionCandidate(candidate);
      const queueBefore = String(
        safeReadFile(process.env.KYBERION_MEMORY_QUEUE_PATH, { encoding: 'utf8' })
      );
      const distill = createDistillCandidateRecord({
        candidate_id: candidate.candidate_id,
        source_type: 'task_session',
        tier: 'confidential',
        scope,
        title: 'Reconciliation operating procedure',
        summary: candidate.summary,
        status: 'proposed',
        target_kind: 'sop_candidate',
        metadata: { knowledge_domain: 'organization', procedure_steps: ['Compare source totals'] },
      });
      expect(() => savePromotedMemoryRecord(distill)).toThrow(
        'Confidential tenant scope is required'
      );
      expect(loadMemoryPromotionCandidate(candidate.candidate_id, scope)).toMatchObject({
        status: 'queued',
        sensitivity_tier: 'confidential',
        scope,
      });
      expect(loadMemoryPromotionCandidate(candidate.candidate_id, scope)).not.toHaveProperty(
        'promoted_ref'
      );
      expect(
        String(safeReadFile(process.env.KYBERION_MEMORY_QUEUE_PATH, { encoding: 'utf8' }))
      ).toBe(queueBefore);
      expect(loadDistillCandidateRecord(candidate.candidate_id)).toBeNull();
    } finally {
      if (savedQueue === undefined) delete process.env.KYBERION_MEMORY_QUEUE_PATH;
      else process.env.KYBERION_MEMORY_QUEUE_PATH = savedQueue;
    }
  });
});
