import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile, safeRmSync } from './secure-io.js';
import {
  createDistillCandidateRecord,
  listDistillCandidateRecords,
  loadDistillCandidateRecord,
  saveDistillCandidateRecord,
  updateDistillCandidateRecord,
} from './distill-candidate-registry.js';
import { buildOrganizationWorkLoopSummary } from './work-design.js';

describe('distill-candidate-registry', () => {
  it('returns null for a missing candidate', () => {
    expect(loadDistillCandidateRecord('DSC-MISSING-REGRESSION')).toBeNull();
  });

  it('creates and persists distill candidates', () => {
    const workLoop = buildOrganizationWorkLoopSummary({
      intentId: 'generate-presentation',
      taskType: 'presentation_deck',
      shape: 'task_session',
      tier: 'confidential',
      projectId: 'PRJ-TEST',
      locale: 'en-US',
      outcomeIds: ['artifact:pptx'],
    });
    const record = createDistillCandidateRecord({
      source_type: 'task_session',
      project_id: 'PRJ-TEST',
      track_id: 'TRK-TEST-REL1',
      track_name: 'Release 1',
      task_session_id: 'TSK-TEST',
      artifact_ids: ['ART-TEST'],
      title: 'Promote reusable deck pattern',
      summary: 'Presentation work produced a reusable planning-to-slide pattern.',
      status: 'proposed',
      target_kind: 'pattern',
      specialist_id: 'document-specialist',
      evidence_refs: ['artifact:ART-TEST'],
      locale: 'en-US',
      work_loop: workLoop,
    });
    saveDistillCandidateRecord(record);
    const loaded = loadDistillCandidateRecord(record.candidate_id);
    expect(loaded?.title).toBe('Promote reusable deck pattern');
    expect(loaded?.track_id).toBe('TRK-TEST-REL1');
    expect(loaded?.work_loop?.resolution.execution_shape).toBe('task_session');
    expect(
      listDistillCandidateRecords().some((item) => item.candidate_id === record.candidate_id)
    ).toBe(true);
  });

  it('persists the canonical candidate payload after updating its timestamp', () => {
    const candidateId = 'DSC-TEST-CANONICAL';
    const filePath = pathResolver.shared(`runtime/distill-candidates/${candidateId}.json`);
    const record = createDistillCandidateRecord({
      candidate_id: candidateId,
      source_type: 'artifact',
      title: 'Canonical candidate',
      summary: 'Candidate metadata is canonicalized before persistence.',
      status: 'proposed',
      target_kind: 'pattern',
      $schema: 'governance-metadata',
    } as unknown as Parameters<typeof createDistillCandidateRecord>[0]);

    try {
      saveDistillCandidateRecord(record);
      const persisted = JSON.parse(String(safeReadFile(filePath, { encoding: 'utf8' }))) as Record<
        string,
        unknown
      >;
      expect(persisted).not.toHaveProperty('$schema');
      expect(persisted.candidate_id).toBe(candidateId);
      expect(persisted.updated_at).toBeTypeOf('string');
    } finally {
      safeRmSync(filePath, { force: true });
    }
  });

  it('updates promotion state and ref', () => {
    const record = createDistillCandidateRecord({
      source_type: 'task_session',
      title: 'Promote SOP',
      summary: 'Operational handling should become a reusable SOP candidate.',
      status: 'proposed',
      target_kind: 'sop_candidate',
    });
    saveDistillCandidateRecord(record);
    const updated = updateDistillCandidateRecord(record.candidate_id, {
      status: 'promoted',
      promoted_ref: 'knowledge/public/common/operations/generated/TEST.md',
    });
    expect(updated?.status).toBe('promoted');
    expect(updated?.promoted_ref).toContain('generated/TEST.md');
  });
});
