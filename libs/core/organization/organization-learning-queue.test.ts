import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeRmSync } from '../secure-io.js';
import { listMemoryPromotionCandidates } from '../knowledge/memory-promotion-queue.js';
import { promoteMemoryCandidateToKnowledge } from '../knowledge/memory-promotion-workflow.js';
import {
  enqueueOrganizationLearningCandidate,
  saveOrganizationLearningCandidate,
} from './organization-operating-model-operations.js';
import { listOrganizationLearningCandidates } from './organization-operating-model-management.js';
import { transitionOrganizationLearningCandidate } from './organization-interventions.js';
import {
  migrateLegacyOrganizationLearningCandidates,
  organizationLearningCandidateId,
  saveOrganizationLearningDecision,
} from './organization-learning-queue.js';
import type { OrganizationLearningCandidate } from './organization-operating-model.js';

const ORG = 'org-learning-queue-test';
const TENANT = 'tenant-learning-queue';

describe('organization learning on the single MemoryCandidate queue (D8)', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = pathResolver.sharedTmp(`organization-learning-queue-${process.pid}`);
    safeRmSync(rootDir, { recursive: true, force: true });
    vi.stubEnv(
      'KYBERION_MEMORY_QUEUE_PATH',
      path.relative(pathResolver.rootDir(), path.join(rootDir, 'promotion-queue.jsonl'))
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    safeRmSync(rootDir, { recursive: true, force: true });
  });

  const legacyRecord = (
    learningId: string,
    overrides: Partial<OrganizationLearningCandidate> = {}
  ): OrganizationLearningCandidate => ({
    version: '1.0.0',
    learning_id: learningId,
    organization_id: ORG,
    source_type: 'incident_review',
    source_ref: `incident-${learningId}`,
    title: `Legacy ${learningId}`,
    summary: `Keep the corrected escalation sequence (${learningId}).`,
    evidence_refs: [],
    target_kind: 'sop_candidate',
    status: 'proposed',
    tier: 'confidential',
    tenant_slug: TENANT,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    ...overrides,
  });

  it('captures on the queue with its real scope and decides there', () => {
    const record = enqueueOrganizationLearningCandidate({
      learningId: 'lrn-new',
      organizationId: ORG,
      sourceType: 'routine_exception',
      sourceRef: 'routine-1',
      title: 'Routine exception',
      summary: 'Escalate a stalled routine after two misses.',
      targetKind: 'pattern',
      tier: 'confidential',
      tenantSlug: TENANT,
      rootDir,
    });
    const rows = listMemoryPromotionCandidates({ tier: 'confidential', tenant_slug: TENANT });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      candidate_id: organizationLearningCandidateId(ORG, 'lrn-new'),
      kind: 'organization_learning',
      status: 'queued',
      scope: { tier: 'confidential', tenant_slug: TENANT, organization_id: ORG },
      origin: { record_kind: 'organization_learning', record_id: 'lrn-new' },
    });
    // The legacy per-organization store is not written.
    expect(safeExistsSync(path.join(rootDir, 'active'))).toBe(false);

    const listed = listOrganizationLearningCandidates({
      organizationId: ORG,
      tier: 'confidential',
      tenantSlug: TENANT,
      rootDir,
    });
    expect(listed).toEqual([
      expect.objectContaining({ learning_id: 'lrn-new', status: 'proposed' }),
    ]);

    const approved = transitionOrganizationLearningCandidate(listed[0]!, 'approved', {
      note: 'useful',
    });
    saveOrganizationLearningDecision(record, approved);
    expect(
      listOrganizationLearningCandidates({
        organizationId: ORG,
        tier: 'confidential',
        tenantSlug: TENANT,
        rootDir,
      })[0]
    ).toMatchObject({ status: 'approved', decision_note: 'useful' });
  });

  it('refuses a capture whose scope the record does not determine', () => {
    expect(() =>
      enqueueOrganizationLearningCandidate({
        learningId: 'lrn-personal',
        organizationId: ORG,
        sourceType: 'routine_exception',
        sourceRef: 'routine-2',
        title: 'Personal',
        summary: 'A personal learning with no owner.',
        targetKind: 'pattern',
        tier: 'personal',
        rootDir,
      })
    ).toThrow('MEMORY_SCOPE_REQUIRED');
  });

  it('migrates pending legacy learnings with their scope and reports the unresolvable', async () => {
    saveOrganizationLearningCandidate(legacyRecord('lrn-pending'), { rootDir });
    saveOrganizationLearningCandidate(
      legacyRecord('lrn-done', { status: 'promoted', promoted_ref: 'knowledge/x.md' }),
      { rootDir }
    );
    saveOrganizationLearningCandidate(
      legacyRecord('lrn-personal', { tier: 'personal', tenant_slug: undefined }),
      { rootDir }
    );
    const query = { organizationId: ORG, rootDir };

    const legacyPending = listOrganizationLearningCandidates({
      ...query,
      tier: 'confidential',
      tenantSlug: TENANT,
    }).find((entry) => entry.learning_id === 'lrn-pending')!;
    expect(() =>
      saveOrganizationLearningDecision(
        legacyPending,
        transitionOrganizationLearningCandidate(legacyPending, 'approved', {})
      )
    ).toThrow('ORGANIZATION_LEARNING_NOT_ON_QUEUE');

    const confidential = migrateLegacyOrganizationLearningCandidates({
      ...query,
      tier: 'confidential',
      tenantSlug: TENANT,
    });
    expect(confidential.mode).toBe('dry_run');
    expect(confidential.imported.map((entry) => entry.learning_id)).toEqual(['lrn-pending']);
    expect(confidential.left_as_history).toEqual([`${ORG}/lrn-done`]);

    const personal = migrateLegacyOrganizationLearningCandidates({ ...query, tier: 'personal' });
    expect(personal.imported).toEqual([]);
    expect(personal.unresolved).toEqual([
      expect.objectContaining({ learning_id: 'lrn-personal', tier: 'personal' }),
    ]);

    migrateLegacyOrganizationLearningCandidates({
      ...query,
      tier: 'confidential',
      tenantSlug: TENANT,
      apply: true,
    });
    expect(
      migrateLegacyOrganizationLearningCandidates({
        ...query,
        tier: 'confidential',
        tenantSlug: TENANT,
      }).already_on_queue
    ).toEqual([`${ORG}/lrn-pending`]);
    const [row] = listMemoryPromotionCandidates({ tier: 'confidential', tenant_slug: TENANT });
    expect(row).toMatchObject({
      scope: { tier: 'confidential', tenant_slug: TENANT, organization_id: ORG },
      origin: { migrated_from: 'organization-learning-store' },
      // A learning without its own evidence is evidenced by its source.
      evidence_refs: ['incident-lrn-pending'],
    });

    // One promotion path per learning: the generic workflow refuses facade-owned rows.
    await expect(
      promoteMemoryCandidateToKnowledge({ candidateId: row!.candidate_id, scope: row!.scope })
    ).rejects.toThrow('MEMORY_PROMOTION_OWNED');
  });
});
