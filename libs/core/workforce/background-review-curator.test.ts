import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withExecutionContext } from '../authority.js';
import { safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import {
  createDistillCandidateRecord,
  loadDistillCandidateRecord,
  saveDistillCandidateRecord,
  updateDistillCandidateRecord,
} from '../knowledge/distill-candidate-registry.js';
import type { MemoryScopeEnvelope } from '../knowledge/memory-scope.js';
import * as approvalReader from '../governance/approval-store-reader.js';
import {
  curateBackgroundReviewProposals,
  restoreBackgroundReviewProposal,
  setBackgroundReviewProposalMaintenance,
} from './background-review-curator.js';

const createdPaths: string[] = [];

function createRecord(input: {
  candidateId: string;
  origin: 'background_review_fork' | 'manual';
  status?: 'proposed' | 'promoted' | 'archived';
  scope?: MemoryScopeEnvelope;
}) {
  const record = createDistillCandidateRecord({
    candidate_id: input.candidateId,
    ...(input.scope ? { scope: input.scope, tier: input.scope.tier } : {}),
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
  createdPaths.push(
    withExecutionContext('surface_runtime', () => saveDistillCandidateRecord(record))
  );
  return record;
}

afterEach(() => {
  vi.restoreAllMocks();
  withExecutionContext('surface_runtime', () => {
    for (const candidatePath of createdPaths.splice(0)) {
      safeRmSync(candidatePath, {
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

  it('keeps pinning and maintenance consent separate from generation provenance', () => {
    const pinned = createRecord({ candidateId: 'CURATOR-PIN-1', origin: 'background_review_fork' });
    const held = createRecord({ candidateId: 'CURATOR-HOLD-1', origin: 'background_review_fork' });
    withExecutionContext('surface_runtime', () => {
      setBackgroundReviewProposalMaintenance({
        candidateId: pinned.candidate_id,
        actorId: 'operator',
        pinned: true,
      });
      setBackgroundReviewProposalMaintenance({
        candidateId: held.candidate_id,
        actorId: 'operator',
        automaticArchive: false,
      });
      const result = curateBackgroundReviewProposals({ now: new Date(Date.now() + 30 * 86400000) });
      expect(result.protected_reasons[pinned.candidate_id]).toContain('pinned');
      expect(result.protected_reasons[held.candidate_id]).toContain('automatic_archive_disabled');
      expect(loadDistillCandidateRecord(pinned.candidate_id)?.metadata?.provenance).toEqual(
        pinned.metadata?.provenance
      );
      expect(loadDistillCandidateRecord(held.candidate_id)?.metadata?.origin).toBe(
        'background_review_fork'
      );
      setBackgroundReviewProposalMaintenance({
        candidateId: pinned.candidate_id,
        actorId: 'operator',
        pinned: false,
      });
      expect(
        curateBackgroundReviewProposals({ now: new Date(Date.now() + 30 * 86400000), dryRun: true })
          .would_archive
      ).toContain(pinned.candidate_id);
    });
  });

  it('protects proposals referenced by pending or approved work without conflating scopes', () => {
    const pending = createRecord({
      candidateId: 'CURATOR-PENDING-1',
      origin: 'background_review_fork',
    });
    const approved = createRecord({
      candidateId: 'CURATOR-APPROVED-1',
      origin: 'background_review_fork',
    });
    const otherScope = createRecord({
      candidateId: 'CURATOR-OTHER-SCOPE-1',
      origin: 'background_review_fork',
    });
    const spy = vi.spyOn(approvalReader, 'listApprovalRequests').mockReturnValue([
      { correlationId: pending.candidate_id, status: 'pending' },
      { correlationId: approved.candidate_id, status: 'approved' },
      {
        correlationId: otherScope.candidate_id,
        status: 'pending',
        scope: { tier: 'confidential', tenant_slug: 'other-tenant' },
      },
    ] as never);
    const result = withExecutionContext('surface_runtime', () =>
      curateBackgroundReviewProposals({ now: new Date(Date.now() + 30 * 86400000), dryRun: true })
    );
    expect(spy).toHaveBeenCalledWith({
      storageChannels: ['background-review'],
      status: ['pending', 'approved'],
    });
    expect(result.protected_reasons[pending.candidate_id]).toContain('active_approval');
    expect(result.protected_reasons[approved.candidate_id]).toContain('active_approval');
    expect(result.would_archive).toContain(otherScope.candidate_id);
  });

  it('restores only curator archives for review and refreshes the retention clock', () => {
    const record = createRecord({
      candidateId: 'CURATOR-RESTORE-1',
      origin: 'background_review_fork',
    });
    const now = new Date(Date.now() + 30 * 86400000);
    withExecutionContext('surface_runtime', () => {
      curateBackgroundReviewProposals({ now });
      const before = loadDistillCandidateRecord(record.candidate_id);
      expect(
        restoreBackgroundReviewProposal({
          candidateId: record.candidate_id,
          actorId: 'operator',
          now,
          dryRun: true,
        })
      ).toMatchObject({ status: 'proposed', changed: true, dry_run: true });
      expect(loadDistillCandidateRecord(record.candidate_id)).toEqual(before);
      const result = restoreBackgroundReviewProposal({
        candidateId: record.candidate_id,
        actorId: 'operator',
        now,
      });
      expect(result.status).toBe('proposed');
      const restored = loadDistillCandidateRecord(record.candidate_id)!;
      expect(restored.promoted_ref).toBeUndefined();
      expect(restored.metadata).toMatchObject({
        archive: { reversible: true, restored_by: 'operator', restored_at: now.toISOString() },
        maintenance: { last_used_at: now.toISOString() },
      });
      expect(restored.metadata?.provenance).toEqual(record.metadata?.provenance);
      expect(curateBackgroundReviewProposals({ now, dryRun: true }).skipped_fresh).toContain(
        record.candidate_id
      );
      expect(() =>
        restoreBackgroundReviewProposal({ candidateId: record.candidate_id, actorId: 'operator' })
      ).toThrow('Only reversible curator archives');
    });
  });

  it('refuses manual/promoted archives and malformed metadata rather than guessing', () => {
    const manual = createRecord({
      candidateId: 'CURATOR-RESTORE-MANUAL',
      origin: 'manual',
      status: 'archived',
    });
    const promoted = createRecord({
      candidateId: 'CURATOR-RESTORE-PROMOTED',
      origin: 'background_review_fork',
      status: 'promoted',
    });
    const invalid = createRecord({
      candidateId: 'CURATOR-MALFORMED',
      origin: 'background_review_fork',
    });
    const archive = createRecord({
      candidateId: 'CURATOR-NONREVERSIBLE',
      origin: 'background_review_fork',
      status: 'archived',
    });
    withExecutionContext('surface_runtime', () => {
      updateDistillCandidateRecord(invalid.candidate_id, {
        metadata: { ...invalid.metadata, maintenance: { pinned: 'yes' } },
      });
      const result = curateBackgroundReviewProposals({ now: new Date(Date.now() + 30 * 86400000) });
      expect(result.protected_reasons[invalid.candidate_id]).toContain('invalid_maintenance');
      for (const candidateId of [manual.candidate_id, promoted.candidate_id, archive.candidate_id])
        expect(() =>
          restoreBackgroundReviewProposal({ candidateId, actorId: 'operator' })
        ).toThrow();
      expect(() =>
        setBackgroundReviewProposalMaintenance({
          candidateId: invalid.candidate_id,
          actorId: 'operator',
          pinned: true,
        })
      ).toThrow('Invalid maintenance metadata');
      expect(() =>
        setBackgroundReviewProposalMaintenance({
          candidateId: archive.candidate_id,
          actorId: '',
          pinned: true,
        })
      ).toThrow('actor id');
      expect(() => curateBackgroundReviewProposals({ now: new Date('invalid') })).toThrow(
        'Invalid now'
      );
    });
  });

  it('addresses the exact scope and never mutates a same-id sibling or legacy record', () => {
    const scope = {
      tier: 'confidential',
      tenant_slug: 'curator-scope-test',
      organization_id: 'org-a',
      project_id: 'project-a',
    } as const;
    const sibling = { ...scope, project_id: 'project-b' };
    const scoped = createRecord({
      candidateId: 'CURATOR-SCOPED-1',
      origin: 'background_review_fork',
      scope,
    });
    createRecord({
      candidateId: scoped.candidate_id,
      origin: 'background_review_fork',
      scope: sibling,
    });
    createRecord({ candidateId: scoped.candidate_id, origin: 'background_review_fork' });
    withExecutionContext('surface_runtime', () => {
      const now = new Date(Date.now() + 30 * 86400000);
      expect(curateBackgroundReviewProposals({ now, scope }).archived).toEqual([
        scoped.candidate_id,
      ]);
      expect(loadDistillCandidateRecord(scoped.candidate_id)?.status).toBe('proposed');
      expect(loadDistillCandidateRecord(scoped.candidate_id, sibling)?.status).toBe('proposed');
      expect(() =>
        restoreBackgroundReviewProposal({
          candidateId: scoped.candidate_id,
          actorId: 'operator',
          scope: sibling,
        })
      ).toThrow();
      restoreBackgroundReviewProposal({
        candidateId: scoped.candidate_id,
        actorId: 'operator',
        scope,
        now,
      });
      expect(loadDistillCandidateRecord(scoped.candidate_id, scope)?.status).toBe('proposed');
    });
  });

  it('rechecks the current record under lock when a pin or promotion races the scan', () => {
    const pinned = createRecord({
      candidateId: 'CURATOR-RACE-PIN',
      origin: 'background_review_fork',
    });
    const promoted = createRecord({
      candidateId: 'CURATOR-RACE-PROMOTE',
      origin: 'background_review_fork',
    });
    vi.spyOn(approvalReader, 'listApprovalRequests').mockImplementation(() => {
      setBackgroundReviewProposalMaintenance({
        candidateId: pinned.candidate_id,
        actorId: 'operator',
        pinned: true,
      });
      updateDistillCandidateRecord(promoted.candidate_id, {
        status: 'promoted',
        promoted_ref: 'knowledge/public/example.md',
      });
      return [];
    });
    withExecutionContext('surface_runtime', () => {
      const result = curateBackgroundReviewProposals({ now: new Date(Date.now() + 30 * 86400000) });
      expect(result.archived).not.toContain(pinned.candidate_id);
      expect(result.archived).not.toContain(promoted.candidate_id);
      expect(result.would_archive).not.toContain(pinned.candidate_id);
      expect(result.protected_reasons[pinned.candidate_id]).toContain('record_changed');
      expect(loadDistillCandidateRecord(pinned.candidate_id)?.metadata?.maintenance).toMatchObject({
        pinned: true,
      });
      expect(loadDistillCandidateRecord(promoted.candidate_id)).toMatchObject({
        status: 'promoted',
        promoted_ref: 'knowledge/public/example.md',
      });
    });
  });

  it('rechecks active references under lock when an approval appears after the scan snapshot', () => {
    // The full suite can populate the legacy registry concurrently. An exact
    // unique scope keeps this two-read ordering assertion about one proposal.
    const scope = {
      tier: 'confidential',
      tenant_slug: `curator-race-${randomUUID().slice(0, 8)}`,
    } as const;
    const record = createRecord({
      candidateId: 'CURATOR-RACE-APPROVAL',
      origin: 'background_review_fork',
      scope,
    });
    const spy = vi
      .spyOn(approvalReader, 'listApprovalRequests')
      .mockReturnValueOnce([])
      .mockReturnValue([
        {
          correlationId: record.candidate_id,
          status: 'pending',
          scope: { ...scope, scope_kind: 'tenant' },
        },
      ] as never);
    withExecutionContext('surface_runtime', () => {
      const result = curateBackgroundReviewProposals({
        now: new Date(Date.now() + 30 * 86400000),
        scope,
      });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(result.archived).not.toContain(record.candidate_id);
      expect(result.would_archive).not.toContain(record.candidate_id);
      expect(loadDistillCandidateRecord(record.candidate_id, scope)?.status).toBe('proposed');
    });
  });
});
