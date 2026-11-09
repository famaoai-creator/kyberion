import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile, safeRmSync } from '../secure-io.js';
import {
  createDistillCandidateRecord,
  saveDistillCandidateRecord,
  type DistillCandidateRecord,
} from '../knowledge/distill-candidate-registry.js';
import { loadMemoryPromotionCandidate } from '../knowledge/memory-promotion-queue.js';
import {
  loadBackgroundReviewProposal,
  migrateLegacyBackgroundReviewProposals,
} from './background-review-proposals.js';

const missionScope = {
  tier: 'confidential' as const,
  tenant_slug: 'bg-review-migration-tenant',
  mission_id: 'MSN-BG-MIGRATION-SCOPED',
};
vi.mock('../knowledge/memory-capture-scope.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../knowledge/memory-capture-scope.js')>();
  return {
    ...actual,
    missionMemoryCaptureScope: (missionId: string) =>
      missionId === 'MSN-BG-MIGRATION-SCOPED'
        ? { tier: 'confidential' as const, scope: missionScope }
        : { tier: 'confidential' as const },
  };
});

const queuePath = `active/shared/tmp/test-memory-queue-background-review-proposals-${process.pid}.jsonl`;
const originalQueuePath = process.env.KYBERION_MEMORY_QUEUE_PATH;
const legacyPaths: string[] = [];
const suffix = `${process.pid}-${Date.now()}`;

beforeAll(() => {
  process.env.KYBERION_MEMORY_QUEUE_PATH = queuePath;
});
afterEach(() => {
  withExecutionContext('surface_runtime', () => {
    for (const file of legacyPaths.splice(0)) safeRmSync(file, { force: true });
    safeRmSync(pathResolver.rootResolve(queuePath), { force: true });
  });
});
afterAll(() => {
  if (originalQueuePath === undefined) delete process.env.KYBERION_MEMORY_QUEUE_PATH;
  else process.env.KYBERION_MEMORY_QUEUE_PATH = originalQueuePath;
});

function legacy(
  id: string,
  overrides: Partial<DistillCandidateRecord> = {},
  metadata: Record<string, unknown> = {}
): DistillCandidateRecord {
  const record = createDistillCandidateRecord({
    candidate_id: `${id}-${suffix}`,
    source_type: 'mission',
    tier: 'confidential',
    title: `Legacy background review ${id}`,
    summary: 'A legacy pipeline proposal written before D8.',
    status: 'proposed',
    target_kind: 'sop_candidate',
    evidence_refs: [`mission:legacy:background-review:${id}`],
    metadata: {
      origin: 'background_review_fork',
      action: 'pipeline_proposal',
      target_ref: 'pipelines/legacy.json',
      patch: { operation: 'append_step', step: { op: 'system:log' } },
      provenance: { generated_by: 'background-review-fork', session_id: 'legacy-session' },
      ...metadata,
    },
    ...overrides,
  });
  legacyPaths.push(
    withExecutionContext('surface_runtime', () => saveDistillCandidateRecord(record))
  );
  return record;
}

describe('background-review proposal migration (D8, one release)', () => {
  it('imports pending legacy proposals with their mission scope and reports the rest', () => {
    const scoped = legacy('BRP-LEGACY-SCOPED', { mission_id: 'MSN-BG-MIGRATION-SCOPED' });
    const noTenant = legacy('BRP-LEGACY-NO-TENANT', { mission_id: 'MSN-BG-MIGRATION-NONE' });
    const session = legacy('BRP-LEGACY-SESSION', {
      source_type: 'task_session',
      tier: 'personal',
    });
    const archived = legacy('BRP-LEGACY-ARCHIVED', {
      mission_id: 'MSN-BG-MIGRATION-SCOPED',
      status: 'archived',
    });

    // Before migration the queue facade refuses to act on a legacy-only id.
    expect(() => loadBackgroundReviewProposal(scoped.candidate_id)).toThrow(
      /BACKGROUND_REVIEW_NOT_ON_QUEUE/
    );

    const dryRun = withExecutionContext('surface_runtime', () =>
      migrateLegacyBackgroundReviewProposals()
    );
    expect(dryRun.mode).toBe('dry_run');
    expect(dryRun.imported).toContainEqual(
      expect.objectContaining({
        candidate_id: scoped.candidate_id,
        tenant_slug: missionScope.tenant_slug,
      })
    );
    expect(dryRun.unresolved.map((entry) => entry.candidate_id)).toEqual(
      expect.arrayContaining([noTenant.candidate_id, session.candidate_id])
    );
    expect(dryRun.left_as_history).toContain(archived.candidate_id);
    expect(loadMemoryPromotionCandidate(scoped.candidate_id)).toBeNull();

    const before = String(safeReadFile(legacyPaths[0]!, { encoding: 'utf8' }));
    const applied = withExecutionContext('surface_runtime', () =>
      migrateLegacyBackgroundReviewProposals({ apply: true })
    );
    expect(applied.imported.map((entry) => entry.candidate_id)).toContain(scoped.candidate_id);
    expect(loadMemoryPromotionCandidate(scoped.candidate_id, missionScope)).toMatchObject({
      kind: 'process_improvement',
      status: 'queued',
      scope: missionScope,
      origin: {
        record_kind: 'background_review',
        decided_via: 'pnpm background-review',
        migrated_from: 'distill-candidate-registry',
      },
    });
    expect(loadBackgroundReviewProposal(scoped.candidate_id)).toMatchObject({
      status: 'proposed',
      metadata: { action: 'pipeline_proposal', target_ref: 'pipelines/legacy.json' },
    });
    // Unresolvable items are never guessed onto the queue; legacy stays history.
    expect(loadMemoryPromotionCandidate(noTenant.candidate_id)).toBeNull();
    expect(loadMemoryPromotionCandidate(session.candidate_id)).toBeNull();
    expect(String(safeReadFile(legacyPaths[0]!, { encoding: 'utf8' }))).toBe(before);

    const again = withExecutionContext('surface_runtime', () =>
      migrateLegacyBackgroundReviewProposals({ apply: true })
    );
    expect(again.already_on_queue).toContain(scoped.candidate_id);
    expect(again.imported.map((entry) => entry.candidate_id)).not.toContain(scoped.candidate_id);
  });

  it('carries an applied, not-yet-rolled-back patch so it stays reversible', () => {
    const applied = legacy(
      'BRP-LEGACY-APPLIED',
      {
        mission_id: 'MSN-BG-MIGRATION-SCOPED',
        status: 'promoted',
        promoted_ref: 'pipelines/legacy.json',
      },
      { patch_application: { backup_ref: 'x', before_sha256: 'a', after_sha256: 'b' } }
    );
    const rolledBack = legacy(
      'BRP-LEGACY-ROLLED-BACK',
      { mission_id: 'MSN-BG-MIGRATION-SCOPED', status: 'promoted' },
      { patch_application: { rollback: { restored_at: 'then' } } }
    );
    const report = withExecutionContext('surface_runtime', () =>
      migrateLegacyBackgroundReviewProposals({ apply: true })
    );
    expect(report.imported.map((entry) => entry.candidate_id)).toContain(applied.candidate_id);
    expect(report.left_as_history).toContain(rolledBack.candidate_id);
    expect(loadBackgroundReviewProposal(applied.candidate_id)).toMatchObject({
      status: 'promoted',
      promoted_ref: 'pipelines/legacy.json',
    });
  });
});
