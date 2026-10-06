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

  it('classifies every mission-shaped ontology intent into the class the ontology declares', () => {
    const drift = intents
      .filter((intent) => intent.execution_shape === 'mission')
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
