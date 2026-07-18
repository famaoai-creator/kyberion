import { afterEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from './authority.js';
import { safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import {
  createDistillCandidateRecord,
  loadDistillCandidateRecord,
  saveDistillCandidateRecord,
} from './distill-candidate-registry.js';
import { curateBackgroundReviewProposals } from './background-review-curator.js';

const createdIds: string[] = [];

function createRecord(input: {
  candidateId: string;
  origin: 'background_review_fork' | 'manual';
  status?: 'proposed' | 'promoted' | 'archived';
}) {
  const record = createDistillCandidateRecord({
    candidate_id: input.candidateId,
    source_type: 'task_session',
    task_session_id: 'CURATOR-TEST-SESSION',
    title: `Curator test ${input.candidateId}`,
    summary: 'A reusable review proposal for curator testing.',
    status: input.status || 'proposed',
    target_kind: 'pattern',
    evidence_refs: [`surface:test:background-review:${input.candidateId}`],
    metadata:
      input.origin === 'background_review_fork'
        ? {
            origin: 'background_review_fork',
            provenance: {
              generated_by: 'background-review-fork',
              session_id: 'CURATOR-TEST-SESSION',
            },
          }
        : { origin: 'manual', provenance: { generated_by: 'operator' } },
  });
  withExecutionContext('surface_runtime', () => saveDistillCandidateRecord(record));
  createdIds.push(record.candidate_id);
  return record;
}

afterEach(() => {
  withExecutionContext('surface_runtime', () => {
    for (const candidateId of createdIds.splice(0)) {
      safeRmSync(pathResolver.shared(`runtime/distill-candidates/${candidateId}.json`), {
        force: true,
      });
    }
  });
});

describe('background-review-curator', () => {
  it('archives only stale background-review proposals and keeps the record reversible', () => {
    const stale = createRecord({
      candidateId: 'CURATOR-STALE-1',
      origin: 'background_review_fork',
    });
    const fresh = createRecord({
      candidateId: 'CURATOR-FRESH-1',
      origin: 'background_review_fork',
    });
    const manual = createRecord({ candidateId: 'CURATOR-MANUAL-1', origin: 'manual' });
    const promoted = createRecord({
      candidateId: 'CURATOR-PROMOTED-1',
      origin: 'background_review_fork',
      status: 'promoted',
    });

    withExecutionContext('surface_runtime', () => {
      const stalePath = pathResolver.shared(
        `runtime/distill-candidates/${stale.candidate_id}.json`
      );
      const staleRecord = JSON.parse(safeReadFile(stalePath, { encoding: 'utf8' }) as string);
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      safeWriteFile(stalePath, JSON.stringify({ ...staleRecord, updated_at: old }));
    });

    const now = new Date();
    const result = withExecutionContext('surface_runtime', () =>
      curateBackgroundReviewProposals({
        now,
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
        limit: 10,
      })
    );

    expect(result.archived).toContain(stale.candidate_id);
    expect(result.skipped_fresh).toContain(fresh.candidate_id);
    expect(result.protected_records).toEqual(
      expect.arrayContaining([manual.candidate_id, promoted.candidate_id])
    );
    expect(loadDistillCandidateRecord(stale.candidate_id)).toMatchObject({
      status: 'archived',
      metadata: {
        origin: 'background_review_fork',
        archive: { previous_status: 'proposed', reversible: true },
      },
    });
    expect(loadDistillCandidateRecord(manual.candidate_id)?.status).toBe('proposed');
    expect(loadDistillCandidateRecord(promoted.candidate_id)?.status).toBe('promoted');
  });

  it('supports dry-run and never archives an unprovenanced record', () => {
    const stale = createRecord({ candidateId: 'CURATOR-DRY-1', origin: 'background_review_fork' });
    const result = withExecutionContext('surface_runtime', () =>
      curateBackgroundReviewProposals({
        now: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        maxAgeMs: 1,
        dryRun: true,
      })
    );

    expect(result.would_archive).toContain(stale.candidate_id);
    expect(result.archived).not.toContain(stale.candidate_id);
    expect(loadDistillCandidateRecord(stale.candidate_id)?.status).toBe('proposed');
  });
});
