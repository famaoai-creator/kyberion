import { describe, expect, it } from 'vitest';
import { buildOrganizationWorkLoopSummary, loadOutcomeCatalog, loadSpecialistCatalog, resolveWorkDesign } from './work-design.js';
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

  it('resolves a knowledge specialist for cross-project remediation analysis', () => {
    const resolved = resolveWorkDesign({
      intentId: 'cross-project-remediation',
      taskType: 'analysis',
      shape: 'task_session',
      outcomeIds: ['remediation_plan'],
    });
    expect(resolved.primary_specialist?.id).toBe('knowledge-specialist');
    expect(resolved.outcomes[0]?.id).toBe('remediation_plan');
  });

  it('resolves a knowledge specialist for incident-informed review', () => {
    const resolved = resolveWorkDesign({
      intentId: 'incident-informed-review',
      taskType: 'analysis',
      shape: 'task_session',
      outcomeIds: ['review_findings'],
    });
    expect(resolved.primary_specialist?.id).toBe('knowledge-specialist');
    expect(resolved.outcomes[0]?.id).toBe('review_findings');
  });

  it('resolves a harness engineer for benchmark-driven harness evolution', () => {
    const resolved = resolveWorkDesign({
      intentId: 'evolve-agent-harness',
      taskType: 'analysis',
      shape: 'task_session',
      outcomeIds: ['harness_experiment_report'],
    });
    expect(resolved.primary_specialist?.id).toBe('harness-engineer');
    expect(resolved.outcomes[0]?.id).toBe('harness_experiment_report');
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

  it('builds an organization work loop summary from task inputs', () => {
    const summary = buildOrganizationWorkLoopSummary({
      intentId: 'generate-presentation',
      taskType: 'presentation_deck',
      shape: 'task_session',
      outcomeIds: ['artifact:pptx'],
      tier: 'confidential',
      projectId: 'PRJ-123',
      projectName: 'Banking App',
      locale: 'ja-JP',
      serviceBindings: ['github:org:banking-app'],
      requiresApproval: false,
    });
    expect(summary.context.project_id).toBe('PRJ-123');
    expect(summary.resolution.execution_shape).toBe('task_session');
    expect(summary.outcome_design.outcome_ids).toContain('artifact:pptx');
    expect(summary.process_design.operator_checklist).toContain('confirm the governed output path');
    expect(summary.runtime_design.owner_model).toBe('single_actor');
    expect(summary.runtime_design.assignment_policy).toBe('direct_specialist');
    expect(summary.execution_boundary.rule).toContain('knowledge defines process');
    expect(summary.teaming.specialist_id).toBe('document-specialist');
  });

  it('builds process design from intent catalog for incident-informed review', () => {
    const summary = buildOrganizationWorkLoopSummary({
      intentId: 'incident-informed-review',
      taskType: 'analysis',
      shape: 'task_session',
      outcomeIds: ['review_findings'],
      tier: 'confidential',
    });
    expect(summary.process_design.plan_outline).toEqual([
      'search incident and failure history',
      'review the current target against those lessons',
      'return governed findings and follow-up checks',
    ]);
    expect(summary.process_design.intake_requirements).toContain('incident basis');
    expect(summary.process_design.operator_checklist).toContain('capture evidence and reusable findings');
    expect(summary.runtime_design.owner_model).toBe('single_owner_multi_worker');
    expect(summary.runtime_design.assignment_policy).toBe('lease_aware_capability');
    expect(summary.runtime_design.coordination.bus).toBe('mission_coordination_bus');
    expect(summary.execution_boundary.compiler_zone.responsibilities).toContain('resolve_target_binding');
    expect(summary.execution_boundary.llm_zone.forbidden).toContain('invent_review_target_bindings');
  });

  it('builds a protected benchmark execution boundary for harness evolution', () => {
    const summary = buildOrganizationWorkLoopSummary({
      intentId: 'evolve-agent-harness',
      taskType: 'analysis',
      shape: 'task_session',
      outcomeIds: ['harness_experiment_report'],
      tier: 'confidential',
    });
    expect(summary.process_design.plan_outline).toEqual([
      'establish the target harness and protected edit boundary',
      'run the baseline benchmark or evaluation corpus',
      'cluster failure modes and choose one general improvement',
      'rerun evaluation and record keep or discard evidence',
    ]);
    expect(summary.process_design.intake_requirements).toContain('target harness');
    expect(summary.execution_boundary.llm_zone.forbidden).toContain('edit_fixed_adapter_boundary_without_approval');
    expect(summary.execution_boundary.compiler_zone.responsibilities).toContain('compile_experiment_contract');
    expect(summary.teaming.specialist_id).toBe('harness-engineer');
  });
});
