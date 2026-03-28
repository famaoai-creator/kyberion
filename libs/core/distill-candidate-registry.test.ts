import { describe, expect, it } from 'vitest';
import { createDistillCandidateRecord, listDistillCandidateRecords, loadDistillCandidateRecord, saveDistillCandidateRecord, updateDistillCandidateRecord } from './distill-candidate-registry.js';

describe('distill-candidate-registry', () => {
  it('creates and persists distill candidates', () => {
    const record = createDistillCandidateRecord({
      source_type: 'task_session',
      project_id: 'PRJ-TEST',
      task_session_id: 'TSK-TEST',
      artifact_ids: ['ART-TEST'],
      title: 'Promote reusable deck pattern',
      summary: 'Presentation work produced a reusable planning-to-slide pattern.',
      status: 'proposed',
      target_kind: 'pattern',
      specialist_id: 'document-specialist',
      evidence_refs: ['artifact:ART-TEST'],
      locale: 'en-US',
    });
    saveDistillCandidateRecord(record);
    const loaded = loadDistillCandidateRecord(record.candidate_id);
    expect(loaded?.title).toBe('Promote reusable deck pattern');
    expect(listDistillCandidateRecords().some((item) => item.candidate_id === record.candidate_id)).toBe(true);
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
