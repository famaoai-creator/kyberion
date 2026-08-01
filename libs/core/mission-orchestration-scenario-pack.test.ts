import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import { resolveIntentResolutionPacket } from './intent-resolution.js';
import { resolveMissionClassification } from './mission-classification.js';
import { resolveMissionWorkflowDesign } from './mission-workflow-catalog.js';
import { resolveMissionReviewDesign } from './mission-review-gates.js';
import { classifyError } from './error-classifier.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

type Scenario = {
  scenario_id: string;
  scenario_class: 'golden' | 'controlled-failure';
  prompt: string;
  expected_signals: string[];
  mission_class: string;
  delivery_shape: string;
  workflow_pattern: string;
};

function loadPack(): { scenarios: Scenario[] } {
  return JSON.parse(
    safeReadFile(
      pathResolver.knowledge('product/governance/mission-orchestration-scenario-pack.json'),
      {
        encoding: 'utf8',
      }
    ) as string
  ) as { scenarios: Scenario[] };
}

function loadJson(relativePath: string): Record<string, any> {
  return JSON.parse(
    safeReadFile(pathResolver.knowledge(relativePath), { encoding: 'utf8' }) as string
  ) as Record<string, any>;
}

describe('mission orchestration scenario pack', () => {
  it('validates the pack schema and purpose declaration', () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = compileSchemaFromPath(
      ajv,
      pathResolver.knowledge('product/schemas/mission-orchestration-scenario-pack.schema.json')
    );
    const pack = loadJson('product/governance/mission-orchestration-scenario-pack.json');
    expect(validate(pack), JSON.stringify(validate.errors || [])).toBe(true);
    expect(pack.purpose).toBe('regression-fixture');
  });

  it('executes every golden prompt through the runtime resolution chain', () => {
    const pack = loadPack();
    const workflowIds = new Set(
      loadJson('product/governance/mission-workflow-catalog.json').templates.map(
        (entry: any) => entry.id
      )
    );
    const patterns = new Set(
      Object.keys(loadJson('product/governance/mission-workflow-catalog.json').patterns)
    );
    const gateIds = new Set(
      loadJson('product/governance/mission-review-gate-registry.json').gates.map(
        (entry: any) => entry.gate_id
      )
    );

    for (const scenario of pack.scenarios.filter((entry) => entry.scenario_class === 'golden')) {
      const packet = resolveIntentResolutionPacket(scenario.prompt);
      const classification = resolveMissionClassification({
        intentId: packet.selected_intent_id,
        taskType: packet.selected_resolution?.task_kind,
        shape: packet.selected_resolution?.shape,
        utterance: scenario.prompt,
      });
      const workflow = resolveMissionWorkflowDesign({
        missionClass: classification.mission_class,
        deliveryShape: classification.delivery_shape,
        riskProfile: classification.risk_profile,
        stage: classification.stage,
        executionShape: packet.selected_resolution?.shape || 'task_session',
        intentId: packet.selected_intent_id,
        taskType: packet.selected_resolution?.task_kind,
      });
      const review = resolveMissionReviewDesign({
        missionClass: classification.mission_class,
        deliveryShape: classification.delivery_shape,
        riskProfile: classification.risk_profile,
        workflowPattern: workflow.pattern,
        stage: classification.stage,
      });

      expect(packet.kind, scenario.scenario_id).toBe('intent_resolution_packet');
      expect(classification.mission_class, scenario.scenario_id).toEqual(expect.any(String));
      expect(classification.delivery_shape, scenario.scenario_id).toEqual(expect.any(String));
      expect(workflowIds.has(workflow.workflow_id), scenario.scenario_id).toBe(true);
      expect(patterns.has(workflow.pattern), scenario.scenario_id).toBe(true);
      expect(
        review.required_gate_ids.every((gateId) => gateIds.has(gateId)),
        scenario.scenario_id
      ).toBe(true);
      expect(scenario.expected_signals.length, scenario.scenario_id).toBeGreaterThan(0);
    }
  });

  it('classifies controlled-failure probes through the error taxonomy', () => {
    const pack = loadPack();
    for (const scenario of pack.scenarios.filter(
      (entry) => entry.scenario_class === 'controlled-failure'
    )) {
      const message = scenario.expected_signals.some((signal) => signal.includes('delegation'))
        ? 'Delegation preflight blocked: permission denied for target path outside allowed scope'
        : scenario.expected_signals.some((signal) => signal.includes('security'))
          ? 'Security review blocked: approval required before proceeding'
          : 'Approval gate blocked: approval required because customer signoff is missing';
      const classification = classifyError(new Error(message));
      expect(classification.category, scenario.scenario_id).not.toBe('unknown');
    }
  });
});
