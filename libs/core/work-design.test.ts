import { describe, expect, it } from 'vitest';
import { loadOutcomeCatalog, loadSpecialistCatalog, resolveWorkDesign } from './work-design.js';
import { createDistillCandidateRecord, saveDistillCandidateRecord } from './distill-candidate-registry.js';

describe('work-design', () => {
  it('loads outcome and specialist catalogs', () => {
    const outcomes = loadOutcomeCatalog();
    const specialists = loadSpecialistCatalog();
    expect(outcomes['artifact:pptx']?.downloadable).toBe(true);
    expect(specialists['document-specialist']?.team_roles).toContain('planner');
  });

  it('resolves a document-specialist team for presentation work', () => {
    const resolved = resolveWorkDesign({
      intentId: 'generate-presentation',
      taskType: 'presentation_deck',
      shape: 'task_session',
      outcomeIds: ['artifact:pptx'],
    });
    expect(resolved.primary_specialist?.id).toBe('document-specialist');
    expect(resolved.outcomes[0]?.id).toBe('artifact:pptx');
  });

  it('resolves a service operator for service operations', () => {
    const resolved = resolveWorkDesign({
      intentId: 'inspect-service',
      taskType: 'service_operation',
      shape: 'task_session',
      outcomeIds: ['service_summary'],
    });
    expect(resolved.primary_specialist?.id).toBe('service-operator');
    expect(resolved.team_roles).toContain('operator');
  });

  it('prefers standard-intent catalog specialist and outcome definitions', () => {
    const resolved = resolveWorkDesign({
      intentId: 'bootstrap-project',
      shape: 'project_bootstrap',
    });
    expect(resolved.primary_specialist?.id).toBe('project-lead');
    expect(resolved.outcomes[0]?.id).toBe('project_created');
  });

  it('surfaces promoted reusable refs for matching specialist work', () => {
    const candidate = createDistillCandidateRecord({
      source_type: 'task_session',
      tier: 'confidential',
      title: 'Reusable reporting template',
      summary: 'artifact:docx reporting flow that should be reused.',
      status: 'promoted',
      target_kind: 'report_template',
      specialist_id: 'document-specialist',
      promoted_ref: 'knowledge/public/common/templates/generated/REPORT.md',
      evidence_refs: ['artifact:docx'],
      metadata: { task_type: 'report_document' },
    });
    saveDistillCandidateRecord(candidate);
    const resolved = resolveWorkDesign({
      intentId: 'generate-report',
      taskType: 'report_document',
      shape: 'task_session',
      outcomeIds: ['artifact:docx'],
      tier: 'confidential',
    });
    expect(resolved.reusable_refs.some((item) => item.candidate_id === candidate.candidate_id)).toBe(true);
  });
});
