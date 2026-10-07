import { describe, expect, it } from 'vitest';
import {
  loadMissionClassPlaybooks,
  renderMissionClassPlaybookBrief,
  resolveMissionClassPlaybook,
  summarizeMissionClassPlaybook,
} from './mission-class-playbook.js';
import { composeMissionTeamBrief } from './mission-team-brief-composer.js';
import { MISSION_CLASS_VALUES } from './mission-classification.js';
import { loadMissionReviewGateRegistry } from './mission-review-gates.js';
import { loadMissionWorkflowCatalog } from './mission-workflow-catalog.js';

const REQUIRED_STAGES = [
  'intake',
  'planning',
  'execution',
  'verification',
  'delivery',
  'retrospective',
];

describe('mission class playbooks', () => {
  const catalog = loadMissionClassPlaybooks();

  it('defines exactly one playbook for every canonical mission class', () => {
    const ids = catalog.playbooks.map((playbook) => playbook.class_id);
    expect([...ids].sort()).toEqual([...MISSION_CLASS_VALUES].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every lifecycle stage a worker passes through, with evidence and know-how', () => {
    for (const playbook of catalog.playbooks) {
      const stages = playbook.approach.map((step) => step.stage);
      for (const stage of REQUIRED_STAGES) {
        expect(stages, `${playbook.class_id} is missing stage ${stage}`).toContain(stage);
      }
      for (const step of playbook.approach) {
        expect(step.know_how.length, `${playbook.class_id}/${step.stage} know_how`).toBeGreaterThan(
          0
        );
        expect(step.evidence.length, `${playbook.class_id}/${step.stage} evidence`).toBeGreaterThan(
          0
        );
      }
    }
  });

  it('only uses postures the catalog defines', () => {
    for (const playbook of catalog.playbooks) {
      expect(Object.keys(catalog.postures), playbook.class_id).toContain(playbook.autonomy.posture);
    }
  });

  it('keeps decisions with humans where the class carries consequences for money, people, or law', () => {
    for (const classId of [
      'finance_and_accounting',
      'people_and_talent',
      'legal_and_compliance',
      'procurement_and_supply',
    ]) {
      const playbook = resolveMissionClassPlaybook(classId as never);
      expect(playbook.autonomy.posture).not.toBe('execute_within_guardrails');
      expect(playbook.autonomy.never_ai.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('names gates that exist in the review registry for the class it describes', () => {
    const registryGateClasses = new Set(
      loadMissionReviewGateRegistry().gates.flatMap(
        (gate) => gate.applies_to?.mission_classes || []
      )
    );
    for (const classId of [
      'finance_and_accounting',
      'people_and_talent',
      'legal_and_compliance',
      'strategy_and_governance',
      'procurement_and_supply',
    ]) {
      expect(registryGateClasses.has(classId), `${classId} has a class-specific review gate`).toBe(
        true
      );
    }
    const workflowClasses = new Set(
      loadMissionWorkflowCatalog().templates.flatMap(
        (template) => template.match?.mission_classes || []
      )
    );
    for (const playbook of catalog.playbooks)
      expect(workflowClasses.has(playbook.class_id)).toBe(true);
  });

  it('renders stage-specific guidance and falls back to the whole approach', () => {
    const stageBrief = renderMissionClassPlaybookBrief('finance_and_accounting', 'verification');
    expect(stageBrief).toContain('### verification');
    expect(stageBrief).not.toContain('### intake');
    expect(stageBrief).toContain('### エスカレーション条件');
    const fullBrief = renderMissionClassPlaybookBrief('finance_and_accounting', 'classification');
    expect(fullBrief).toContain('### intake');
    expect(fullBrief).toContain('### retrospective');
  });

  it('localizes section labels', () => {
    const brief = renderMissionClassPlaybookBrief('finance_and_accounting', 'verification', 'en');
    expect(brief).toContain('### Escalate when');
    expect(brief).toContain('Finance & accounting');
  });

  it('summarizes a playbook for embedding in a mission', () => {
    const summary = summarizeMissionClassPlaybook('legal_and_compliance', 'execution');
    expect(summary.class_id).toBe('legal_and_compliance');
    expect(summary.posture).toBe('analyze_for_review');
    expect(summary.posture_description.length).toBeGreaterThan(0);
    expect(summary.brief).toContain('### execution');
  });

  it('fails closed for a class without a playbook', () => {
    expect(() => resolveMissionClassPlaybook('not_a_class' as never)).toThrow(
      /No mission class playbook/
    );
  });

  it('attaches the class playbook to the composed mission team brief', () => {
    const brief = composeMissionTeamBrief({
      missionId: 'MSN-PLAYBOOK-WIRING-TEST',
      request: '給与計算を回したい',
      intentId: 'payroll-cycle',
      shape: 'mission',
      executionShape: 'mission',
    });
    expect(brief.mission_classification.mission_class).toBe('finance_and_accounting');
    expect(brief.mission_type).toBe('finance_operations');
    expect(brief.class_playbook.class_id).toBe('finance_and_accounting');
    expect(brief.class_playbook.posture).toBe('prepare_for_approval');
    expect(brief.review_design.required_gate_ids).toContain('FINANCIAL_CONTROLS');
    expect(brief.rationale.join('\n')).toContain('Class playbook finance_and_accounting');
    const assigned = brief.team_plan.assignments.map((entry) => entry.team_role);
    expect(assigned).toContain('tracker');
  });
});
