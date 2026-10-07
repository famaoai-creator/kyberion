import { describe, expect, it } from 'vitest';
import { loadIntentDomainOntologyCatalog } from '../intent/intent-resolution.js';
import { MISSION_CLASS_VALUES, resolveMissionClassification } from './mission-classification.js';
import { resolveMissionWorkflowDesign } from './mission-workflow-catalog.js';
import { loadMissionWorkflowCatalog } from './mission-workflow-catalog.js';

const ORGANIZATION_CLASSES = [
  'finance_and_accounting',
  'people_and_talent',
  'legal_and_compliance',
  'strategy_and_governance',
  'procurement_and_supply',
] as const;

describe('mission class ↔ intent ontology parity', () => {
  const intents = loadIntentDomainOntologyCatalog().intents || [];

  // Generic reasoning-pattern intents are matched on broad keywords and can be
  // mis-resolved for ordinary code requests (e.g. `chain-of-thought-planning`
  // for a shebang fix). Their declared class is deliberately not enforced, so
  // such requests keep falling back to the code_change default.
  const REASONING_PATTERN_INTENTS = new Set([
    'diverge-hypotheses',
    'chain-of-thought-planning',
    'plan-and-execute',
    'multi-agent-consensus',
    'counterfactual-simulation',
    'adaptive-reasoning',
    'tool-use-expert',
    'active-learning-escalate',
    'recall-prior-knowledge',
  ]);

  it('classifies every ontology intent into the class the ontology declares', () => {
    const drift = intents
      .filter((intent) => !REASONING_PATTERN_INTENTS.has(intent.intent_id))
      .map((intent) => ({
        intent: intent.intent_id,
        declared: intent.mission_class,
        resolved: resolveMissionClassification({
          intentId: intent.intent_id,
          shape: intent.execution_shape,
        }).mission_class,
      }))
      .filter((entry) => entry.declared !== entry.resolved);
    expect(drift, `ontology/classification drift: ${JSON.stringify(drift)}`).toEqual([]);
  });

  it('only declares canonical mission classes', () => {
    for (const intent of intents) {
      expect(MISSION_CLASS_VALUES as readonly string[]).toContain(intent.mission_class);
    }
  });

  it('routes every organization-class intent to its dedicated workflow template', () => {
    const templateIds = new Set(loadMissionWorkflowCatalog().templates.map((entry) => entry.id));
    const organizationIntents = intents.filter((intent) =>
      (ORGANIZATION_CLASSES as readonly string[]).includes(intent.mission_class || '')
    );
    expect(organizationIntents.length).toBeGreaterThan(0);
    for (const intent of organizationIntents) {
      const classification = resolveMissionClassification({
        intentId: intent.intent_id,
        shape: intent.execution_shape,
      });
      const workflow = resolveMissionWorkflowDesign({
        missionClass: classification.mission_class,
        deliveryShape: classification.delivery_shape,
        riskProfile: classification.risk_profile,
        stage: classification.stage,
        executionShape: (intent.execution_shape as 'mission') || 'mission',
        intentId: intent.intent_id,
      });
      expect(templateIds.has(intent.workflow_template || ''), intent.intent_id).toBe(true);
      expect(workflow.workflow_id, `${intent.intent_id} must reach its own workflow`).toBe(
        intent.workflow_template
      );
      expect(classification.risk_profile, `${intent.intent_id} risk`).toBe(intent.risk_profile);
    }
  });
});

describe('reasoning-pattern intents classify only on their distinctive phrasing', () => {
  const classify = (intentId: string, utterance: string) =>
    resolveMissionClassification({ intentId, utterance }).mission_class;

  it('rescues the declared class when the phrasing is distinctive', () => {
    expect(classify('multi-agent-consensus', '関係者の賛否を整理して')).toBe('decision_support');
    expect(classify('counterfactual-simulation', '反事実シミュレーションして')).toBe(
      'decision_support'
    );
    expect(classify('recall-prior-knowledge', '過去の類似失敗を思い出して')).toBe(
      'research_and_absorption'
    );
  });

  it('keeps ordinary code requests on the default even when the intent mis-resolves', () => {
    for (const utterance of ['shebang を追加して設計をテストして', 'この関数のテストを実行して']) {
      expect(classify('chain-of-thought-planning', utterance)).toBe('code_change');
    }
  });
});
